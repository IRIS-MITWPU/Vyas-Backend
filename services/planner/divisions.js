import { z } from "zod";
import { MAX_HOME_ROOMS, homeRoomIds } from "./domain/homeRooms.js";
import { pool, withTransaction } from "./tx.js";
import { parse, failField, text, intIn, uuid } from "./validate.js";
import { LIMITS } from "./domain/limits.js";
import { notFound, duplicate, invalid, orDuplicate, placedSessions } from "./errors.js";
import { requireTerm } from "./terms.js";
import { removeUnplacedSessions, lockTermVersions, countPlacedSharedLabSessions, studentCountLocked } from "./guards.js";

// lockTermVersions lives in guards.js (no import cycle with offerings/rooms/terms); re-exported for the importer and subjects.
export { lockTermVersions };

const batchName = text(LIMITS.batch_name).refine((s) => s.toLowerCase() !== "all", 'The name "ALL" is reserved for the whole division');
const batchInput = z.object({ name: batchName, student_count: intIn(LIMITS.student_count).default(0) });

const createSchema = z.object({
  semester: intIn(LIMITS.semester),
  name: text(LIMITS.division_name),
  student_count: intIn(LIMITS.student_count).default(0),
  home_room_id: uuid.nullable().optional(),
  // contract 10.3: at most 2 home classrooms; wins over the legacy home_room_id when both are sent
  home_room_ids: z.array(uuid).max(MAX_HOME_ROOMS, `a division has at most ${MAX_HOME_ROOMS} home classrooms`).optional(),
  batches: z.array(batchInput).max(30).optional(),
});
const patchSchema = z.object({
  semester: intIn(LIMITS.semester),
  name: text(LIMITS.division_name),
  student_count: intIn(LIMITS.student_count),
  home_room_id: uuid.nullable(),
  home_room_ids: z.array(uuid).max(MAX_HOME_ROOMS, `a division has at most ${MAX_HOME_ROOMS} home classrooms`),
}).partial();
const batchPatchSchema = z.object({ name: batchName, student_count: intIn(LIMITS.student_count) }).partial();

const DIV_COLS = "d.id, d.term_id, d.semester, d.name, d.student_count, d.home_room_id, d.home_room2_id";
const BATCH_COLS = "b.id, b.division_id, b.name, b.student_count, b.is_whole";

/**
 * The home rooms a create/patch asks for, as a de-duplicated list (null = the body says nothing about them).
 * home_room_ids wins; the legacy home_room_id sets the first room and keeps the second one (patch) / none (create).
 */
function requestedHomeRooms(b, current = null) {
  if (b.home_room_ids !== undefined) {
    const ids = [...new Set(b.home_room_ids)];
    if (ids.length !== b.home_room_ids.length) failField("home_room_ids", "the same room is listed twice");
    return ids;
  }
  if (b.home_room_id !== undefined) {
    const rest = current ? homeRoomIds(current).slice(1) : [];
    return [b.home_room_id, ...rest].filter((x, i, a) => x && a.indexOf(x) === i).slice(0, MAX_HOME_ROOMS);
  }
  return null;
}

/** Every home room must exist, be active, be in the term's building (when it has one) and not be a lab room. */
async function assertHomeRooms(db, termId, ids) {
  if (!ids.length) return;
  const { rows: [term] } = await db.query("SELECT building_id FROM planner_terms WHERE id = $1", [termId]);
  const { rows } = await db.query(
    `SELECT r.id, r.name, r.is_active, r.room_type::text AS room_type, f.building_id, tr.is_lab AS pool_is_lab
       FROM rooms r JOIN floors f ON f.id = r.floor_id
       LEFT JOIN planner_term_rooms tr ON tr.room_id = r.id AND tr.term_id = $2
      WHERE r.id = ANY($1::uuid[])`,
    [ids, termId]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  ids.forEach((id, i) => {
    const field = `home_room_ids.${i}`;
    const r = byId.get(id);
    if (!r) failField(field, "room not found");
    if (r.is_active === false) failField(field, `${r.name} is not an active room`);
    if (term?.building_id && r.building_id !== term.building_id) failField(field, `${r.name} is not in this term's building`);
    // the term pool's own is_lab flag decides (it can override room_type per term); rooms outside the pool fall back to room_type
    const isLab = r.pool_is_lab ?? r.room_type === "lab";
    if (isLab) failField(field, `${r.name} is a lab room; home rooms are classrooms`);
  });
}

/** Writes the two home room columns for a division. */
const homeColumns = (ids) => [ids[0] ?? null, ids[1] ?? null];

/** Adds the derived `home_room_ids` (0-2 ids, first room first) to a division row. */
function withHomeRooms(d) {
  d.home_room_ids = homeRoomIds(d);
  return d;
}

async function divisionsWithBatches(db, where, params) {
  const { rows: divisions } = await db.query(
    `SELECT ${DIV_COLS} FROM planner_divisions d WHERE ${where} ORDER BY d.semester, lower(d.name), d.name`,
    params
  );
  if (!divisions.length) return [];
  const { rows: batches } = await db.query(
    `SELECT ${BATCH_COLS} FROM planner_batches b WHERE b.division_id = ANY($1::uuid[]) ORDER BY b.is_whole DESC, lower(b.name)`,
    [divisions.map((d) => d.id)]
  );
  for (const d of divisions) {
    d.batches = batches.filter((b) => b.division_id === d.id);
    withHomeRooms(d);
  }
  return divisions;
}

/** Divisions of a term (semester, name order) with their batches (whole batch first). */
export const loadDivisions = (db, termId) => divisionsWithBatches(db, "d.term_id = $1", [termId]);

export async function listDivisions(termId) {
  await requireTerm(pool, termId);
  return divisionsWithBatches(pool, "d.term_id = $1", [termId]);
}

export async function getDivision(db, termId, did) {
  const [d] = await divisionsWithBatches(db, "d.term_id = $1 AND d.id = $2", [termId, did]);
  if (!d) throw notFound("Division not found");
  return d;
}

async function assertDivisionNameFree(db, termId, semester, name, exceptId = null) {
  const { rows } = await db.query(
    `SELECT 1 FROM planner_divisions WHERE term_id = $1 AND semester = $2 AND lower(name) = lower($3) AND id IS DISTINCT FROM $4`,
    [termId, semester, name, exceptId]
  );
  if (rows.length) throw duplicate("A division with this name already exists in that semester");
}

function assertUniqueBatchNames(batches) {
  const seen = new Set();
  batches.forEach((b, i) => {
    const k = b.name.toLowerCase();
    if (seen.has(k)) failField(`batches.${i}.name`, `batch "${b.name}" is listed twice`);
    seen.add(k);
  });
}

export async function createDivision(termId, body) {
  await requireTerm(pool, termId);
  const b = parse(createSchema, body);
  assertUniqueBatchNames(b.batches ?? []);
  return orDuplicate("A division with this name already exists in that semester", () =>
    withTransaction(async (db) => {
      await requireTerm(db, termId, { lock: true });
      const homeIds = requestedHomeRooms(b) ?? [];
      await assertHomeRooms(db, termId, homeIds);
      await assertDivisionNameFree(db, termId, b.semester, b.name);
      const [h1, h2] = homeColumns(homeIds);
      const { rows: [{ id }] } = await db.query(
        `INSERT INTO planner_divisions (term_id, semester, name, student_count, home_room_id, home_room2_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [termId, b.semester, b.name, b.student_count, h1, h2]
      );
      await db.query(
        "INSERT INTO planner_batches (division_id, name, student_count, is_whole) VALUES ($1, 'ALL', $2, true)",
        [id, b.student_count]
      );
      for (const batch of b.batches ?? []) {
        await db.query("INSERT INTO planner_batches (division_id, name, student_count) VALUES ($1,$2,$3)", [id, batch.name, batch.student_count]);
      }
      return getDivision(db, termId, id);
    })
  );
}

export async function updateDivision(termId, did, body) {
  const patch = parse(patchSchema, body);
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!keys.length) failField("_", "No fields to update");
  for (const k of ["semester", "name", "student_count"]) if (patch[k] === null) failField(k, "cannot be empty");
  return orDuplicate("A division with this name already exists in that semester", () =>
    withTransaction(async (db) => {
      // a student-count edit must not race a placement in flight (it decides shared lab room capacity)
      if (patch.student_count !== undefined) await lockTermVersions(db, termId);
      const current = await getDivision(db, termId, did);
      if (patch.student_count !== undefined && patch.student_count !== current.student_count) {
        const n = await countPlacedSharedLabSessions(db, "division", did);
        if (n > 0) throw studentCountLocked(`Division ${current.name}`, n);
      }
      const homeIds = requestedHomeRooms(patch, current);
      if (homeIds) await assertHomeRooms(db, termId, homeIds);
      const semester = patch.semester ?? current.semester;
      const name = patch.name ?? current.name;
      if (semester !== current.semester || name !== current.name) await assertDivisionNameFree(db, termId, semester, name, did);
      const sets = [];
      const vals = [did];
      for (const k of keys) {
        if (k === "home_room_id" || k === "home_room_ids") continue; // written below, as the pair
        vals.push(patch[k]);
        sets.push(`${k} = $${vals.length}`);
      }
      if (homeIds) {
        const [h1, h2] = homeColumns(homeIds);
        vals.push(h1, h2);
        sets.push(`home_room_id = $${vals.length - 1}`, `home_room2_id = $${vals.length}`);
      }
      if (sets.length) await db.query(`UPDATE planner_divisions SET ${sets.join(", ")} WHERE id = $1`, vals);
      if (patch.student_count !== undefined) {
        // the whole batch always mirrors the division
        await db.query("UPDATE planner_batches SET student_count = $2 WHERE division_id = $1 AND is_whole", [did, patch.student_count]);
      }
      return getDivision(db, termId, did);
    })
  );
}

/** Returns the draft versions whose rev was bumped ([{version_id, prev_rev, rev}]) so the route can emit planner:changed. */
export async function deleteDivision(termId, did) {
  return withTransaction(async (db) => {
    const d = await getDivision(db, termId, did);
    const bumps = await removeUnplacedSessions(db, termId, "division", did, `Division ${d.name}`);
    await db.query("DELETE FROM planner_divisions WHERE id = $1", [did]);
    return bumps;
  });
}

// ------------------------------------------------------------ batches

async function getBatch(db, termId, did, bid) {
  const { rows } = await db.query(
    `SELECT ${BATCH_COLS} FROM planner_batches b JOIN planner_divisions d ON d.id = b.division_id
      WHERE b.id = $1 AND d.id = $2 AND d.term_id = $3`,
    [bid, did, termId]
  );
  if (!rows[0]) throw notFound("Batch not found");
  return rows[0];
}

async function assertBatchNameFree(db, did, name, exceptId = null) {
  const { rows } = await db.query(
    "SELECT 1 FROM planner_batches WHERE division_id = $1 AND lower(name) = lower($2) AND id IS DISTINCT FROM $3",
    [did, name, exceptId]
  );
  if (rows.length) throw duplicate("A batch with this name already exists in this division");
}

/** Division ids (among `divisionIds`) that have a placed session on their whole batch, in any version. */
export async function divisionsWithPlacedWholeSessions(db, divisionIds) {
  if (!divisionIds.length) return new Set();
  const { rows } = await db.query(
    `SELECT DISTINCT b.division_id FROM planner_sessions s JOIN planner_batches b ON b.id = s.batch_id
      WHERE b.is_whole AND s.weekday IS NOT NULL AND b.division_id = ANY($1::uuid[])`,
    [divisionIds]
  );
  return new Set(rows.map((r) => r.division_id));
}

export async function createBatch(termId, did, body) {
  const b = parse(batchInput, body);
  return orDuplicate("A batch with this name already exists in this division", () =>
    withTransaction(async (db) => {
      const division = await getDivision(db, termId, did);
      // a placed whole-division session needs an occupancy row per batch, so no batch may appear under it
      await lockTermVersions(db, termId);
      if ((await divisionsWithPlacedWholeSessions(db, [did])).has(did)) {
        throw placedSessions(
          `Whole-division sessions of ${division.name} are placed on the timetable. Unplace them before adding a batch.`,
          { division_id: did }
        );
      }
      await assertBatchNameFree(db, did, b.name);
      const { rows: [{ id }] } = await db.query(
        "INSERT INTO planner_batches (division_id, name, student_count) VALUES ($1,$2,$3) RETURNING id",
        [did, b.name, b.student_count]
      );
      return getBatch(db, termId, did, id);
    })
  );
}

export async function updateBatch(termId, did, bid, body) {
  const patch = parse(batchPatchSchema, body);
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!keys.length) failField("_", "No fields to update");
  return orDuplicate("A batch with this name already exists in this division", () =>
    withTransaction(async (db) => {
      if (patch.student_count !== undefined) await lockTermVersions(db, termId);
      const current = await getBatch(db, termId, did, bid);
      if (current.is_whole) throw invalid("The whole-division batch is managed automatically and cannot be edited", { _: ["whole batch"] });
      if (patch.student_count !== undefined && patch.student_count !== current.student_count) {
        const n = await countPlacedSharedLabSessions(db, "batch", bid);
        if (n > 0) throw studentCountLocked(`Batch ${current.name}`, n);
      }
      if (patch.name && patch.name.toLowerCase() !== current.name.toLowerCase()) await assertBatchNameFree(db, did, patch.name, bid);
      const sets = [];
      const vals = [bid];
      for (const k of keys) {
        vals.push(patch[k]);
        sets.push(`${k} = $${vals.length}`);
      }
      await db.query(`UPDATE planner_batches SET ${sets.join(", ")} WHERE id = $1`, vals);
      return getBatch(db, termId, did, bid);
    })
  );
}

/** Returns the draft versions whose rev was bumped ([{version_id, prev_rev, rev}]) so the route can emit planner:changed. */
export async function deleteBatch(termId, did, bid) {
  return withTransaction(async (db) => {
    const batch = await getBatch(db, termId, did, bid);
    if (batch.is_whole) throw invalid("The whole-division batch cannot be deleted", { _: ["whole batch"] });
    const bumps = await removeUnplacedSessions(db, termId, "batch", bid, `Batch ${batch.name}`);
    // placed whole-division sessions keep one 'batch' occupancy row per non-whole batch: drop this batch's rows
    await db.query("DELETE FROM planner_occupancy WHERE kind = 'batch' AND resource_id = $1", [bid]);
    await db.query("DELETE FROM planner_batches WHERE id = $1", [bid]);
    return bumps;
  });
}
