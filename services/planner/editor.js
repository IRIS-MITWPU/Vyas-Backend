// Timetable editor service (Phase 2): snapshot read + the atomic ops write path.
//
// Concurrency model: every write request runs in ONE transaction that first locks the version row
// (getVersion(..., {lock:true})). Placements of one version are therefore strictly serial: inside the lock a
// session's own occupancy rows are deleted, every new row is pre-checked with an explicit overlap query
// (own session excluded) and then inserted. The EXCLUDE constraint on planner_occupancy is only a backstop for
// the exclusive kinds; should it ever fire (23P01) the planner router turns it into a generic 409 CLASH.
//
// Lab-room sharing (contract 8.7): a lab session in a lab room of known capacity writes its room row with kind
// 'lab_room'. That kind is exempt from the exclusion constraint, so the capacity of a shared room is guarded
// ONLY by the version-row lock plus the pre-check below (max concurrent student load <= rooms.capacity).
import { z } from "zod";
import { pool, withTransaction } from "./tx.js";
import { parse, uuid, int } from "./validate.js";
import {
  PlannerError, notFound, invalid, sessionLocked, placementInvalid, noRoomAvailable, notDraft, clash,
} from "./errors.js";
import { requireTerm } from "./terms.js";
import { loadDivisions } from "./divisions.js";
import { loadOfferings } from "./offerings.js";
import { loadPoolRooms } from "./rooms.js";
import { loadSubjects } from "./state.js";
import { getVersion, loadSessions } from "./sessions.js";
import {
  checkPlacement, occupancyRows, pickRoom, describeConflict, describeCapacity, fitsInRoom, isShareable, peakLoad, studentsFor,
} from "./domain/index.js";

// ------------------------------------------------------------------ snapshot

/**
 * Everything the editor needs in one consistent read: one REPEATABLE READ READ ONLY transaction, so `rev`
 * and the data belong to the same moment. (withTransaction takes no isolation options, hence the direct client.)
 */
export async function getSnapshot(versionId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const version = await getVersion(client, versionId);
    const term = await requireTerm(client, version.term_id);
    const divisions = await loadDivisions(client, term.id);
    const subjects = await loadSubjects(client, term.id);
    const offerings = await loadOfferings(client, term.id);
    const { rows: faculty } = await client.query(
      `SELECT id, short_code, full_name, department, max_per_day, max_per_week, is_active
         FROM planner_faculty WHERE is_active ORDER BY lower(short_code), short_code`
    );
    const rooms = await loadPoolRooms(client, term.id);
    const sessions = await loadSessions(client, versionId);
    await client.query("COMMIT");
    return {
      rev: Number(version.rev),
      version: { id: version.id, term_id: version.term_id, version_no: version.version_no, status: version.status },
      term, divisions, subjects, offerings, faculty, rooms, sessions,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("Planner rollback failed:", rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------------ ops

const sessionId = { session_id: uuid };
const weekday = int(0, 6);
const startMin = int(0, 1440);
const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("place"), ...sessionId, weekday, start_min: startMin, room_id: uuid.nullish() }),
  z.object({ op: z.literal("move"), ...sessionId, weekday, start_min: startMin, room_id: uuid.nullish() }),
  z.object({ op: z.literal("unplace"), ...sessionId }),
  z.object({ op: z.literal("lock"), ...sessionId }),
  z.object({ op: z.literal("unlock"), ...sessionId }),
  z.object({ op: z.literal("set_room"), ...sessionId, room_id: uuid }),
  z.object({
    op: z.literal("set_faculty"),
    ...sessionId,
    faculty_ids: z.array(uuid).min(1, "choose at least one faculty member").max(50).transform((a) => [...new Set(a)]),
  }),
]);
const bodySchema = z.object({
  client_id: z.string().max(64, "must be at most 64 characters").nullish(),
  ops: z.array(opSchema).min(1, "at least one op is required").max(50, "at most 50 ops per request"),
});

/** How long an ops request may wait for a row lock (PG lock_timeout). */
const OPS_LOCK_TIMEOUT_MS = 10000;

const KIND_ORDER = { faculty: 0, room: 1, batch: 2 };

/** Loads what the ops need to know about the version's term once per request. */
async function loadContext(db, version) {
  const term = await requireTerm(db, version.term_id);
  const poolRooms = await loadPoolRooms(db, term.id);
  const subjects = new Map((await loadSubjects(db, term.id)).map((s) => [s.id, s]));
  const divisions = new Map();
  const batchInfo = new Map(); // batch id -> {division, batch}
  for (const d of await loadDivisions(db, term.id)) {
    divisions.set(d.id, d);
    for (const b of d.batches) batchInfo.set(b.id, { division: d, batch: b });
  }
  return {
    term, subjects, divisions, batchInfo, poolRooms,
    poolRoomIds: new Set(poolRooms.map((r) => r.room_id)),
    roomsById: new Map(poolRooms.map((r) => [r.room_id, r])),
  };
}

/** The touched sessions with the ids needed to apply ops (not the public shape). */
async function loadWorkingSessions(db, versionId, ids) {
  const { rows } = await db.query(
    `SELECT s.id, s.batch_id, s.weekday, s.start_min, s.end_min, s.room_id, s.locked, o.division_id, o.subject_id
       FROM planner_sessions s JOIN planner_offerings o ON o.id = s.offering_id
      WHERE s.version_id = $1 AND s.id = ANY($2::uuid[])`,
    [versionId, ids]
  );
  const map = new Map(rows.map((r) => [r.id, { ...r, faculty_ids: [] }]));
  const { rows: fac } = await db.query("SELECT session_id, faculty_id FROM planner_session_faculty WHERE session_id = ANY($1::uuid[])", [ids]);
  for (const f of fac) map.get(f.session_id)?.faculty_ids.push(f.faculty_id);
  return map;
}

const isPlaced = (s) => s.weekday !== null && s.weekday !== undefined;

const sameSlot = (a, b) =>
  a.weekday === b.weekday && a.start_min === b.start_min && a.end_min === b.end_min && a.room_id === b.room_id;

/** Students a session brings to a room: its batch, or the whole division for the whole batch. */
const STUDENTS_SQL = "CASE WHEN b.is_whole THEN d.student_count ELSE b.student_count END";

/**
 * What the other sessions of the version put on each room during [start, end) of a weekday:
 * Map room_id -> {exclusiveBusy, sharedPeak, shared}. exclusiveBusy = an exclusive 'room' row overlaps;
 * sharedPeak = peak concurrent students of the overlapping 'lab_room' rows (inside the interval).
 */
async function roomLoadsAt(db, versionId, day, start, end, exceptSessionId) {
  const { rows } = await db.query(
    `SELECT o.resource_id, o.kind, lower(o.during) AS start_min, upper(o.during) AS end_min, ${STUDENTS_SQL} AS students
       FROM planner_occupancy o
       JOIN planner_sessions s ON s.id = o.session_id
       JOIN planner_batches b ON b.id = s.batch_id
       JOIN planner_divisions d ON d.id = b.division_id
      WHERE o.version_id = $1 AND o.kind IN ('room', 'lab_room') AND o.weekday = $2
        AND o.during && int4range($3, $4, '[)') AND o.session_id <> $5`,
    [versionId, day, start, end, exceptSessionId]
  );
  const byRoom = new Map();
  for (const r of rows) {
    if (!byRoom.has(r.resource_id)) byRoom.set(r.resource_id, { exclusiveBusy: false, shared: [] });
    const e = byRoom.get(r.resource_id);
    if (r.kind === "room") e.exclusiveBusy = true;
    else e.shared.push({ start_min: r.start_min, end_min: r.end_min, students: r.students });
  }
  const loads = new Map();
  for (const [id, e] of byRoom) {
    loads.set(id, {
      exclusiveBusy: e.exclusiveBusy,
      sharedPeak: peakLoad(e.shared, { start_min: start, end_min: end }),
      shared: e.shared.length > 0,
    });
  }
  return loads;
}

/**
 * Capacity check of the shared ('lab_room') candidate rows: for each one, the max concurrent student load over its
 * interval (overlapping lab_room rows of other sessions + the candidate) must fit rooms.capacity. Always runs
 * for a shared candidate, also when no other shared session overlaps: a session that is bigger than the room on
 * its own is rejected too (contract 8.7.3 read literally). Classrooms / non-shareable rooms are not checked here.
 * Returns conflicts shaped like the others (kind 'room').
 */
async function capacityConflicts(db, versionId, ctx, selfId, rows, need) {
  const out = [];
  for (const r of rows) {
    if (r.kind !== "lab_room") continue;
    const room = ctx.roomsById.get(r.resource_id);
    const { rows: held } = await db.query(
      `SELECT o.session_id, lower(o.during) AS start_min, upper(o.during) AS end_min, ${STUDENTS_SQL} AS students,
              sub.code AS subject_code, sub.name AS subject_name, d.name AS division_name, d.semester,
              b.name AS batch_name, b.is_whole
         FROM planner_occupancy o
         JOIN planner_sessions s ON s.id = o.session_id
         JOIN planner_offerings off ON off.id = s.offering_id
         JOIN planner_subjects sub ON sub.id = off.subject_id
         JOIN planner_batches b ON b.id = s.batch_id
         JOIN planner_divisions d ON d.id = b.division_id
        WHERE o.version_id = $1 AND o.kind = 'lab_room' AND o.resource_id = $2 AND o.weekday = $3
          AND o.during && int4range($4, $5, '[)') AND o.session_id <> $6
        ORDER BY lower(o.during), d.semester, d.name, b.name, s.id`,
      [versionId, r.resource_id, r.weekday, r.start_min, r.end_min, selfId]
    );
    const fit = fitsInRoom({
      capacity: room?.capacity, existing: held, candidate: { start_min: r.start_min, end_min: r.end_min, students: need },
    });
    if (fit.ok) continue;
    const holders = [...new Map(held.map((h) => [h.session_id, h])).values()];
    const text = describeCapacity({
      roomName: room?.name, capacity: room?.capacity, peak: fit.peak, weekday: r.weekday, start_min: r.start_min, end_min: r.end_min, holders,
    });
    out.push({ kind: "room", resource_id: r.resource_id, resource_name: room?.name ?? "this room", session_id: held[0]?.session_id ?? selfId, text });
  }
  return out;
}

/**
 * Explicit overlap check of new occupancy rows against the rest of the version (the session's own rows are
 * excluded). Returns { conflicts, capacity }: ALL conflicts (faculty, room, batch) as
 * [{kind, resource_id, resource_name, session_id, text}] and whether one of them is a ROOM_CAPACITY one.
 * Kind matrix (contract 8.7.3): an exclusive 'room' candidate clashes with 'room' and 'lab_room' rows, a shared
 * 'lab_room' candidate clashes with 'room' rows only (its lab_room neighbours are checked by capacity); the
 * other kinds clash with their own kind. Conflicts of both room kinds are reported as kind 'room'.
 */
async function findConflicts(db, versionId, ctx, selfId, rows, need) {
  if (!rows.length) return { conflicts: [], capacity: false };
  const { rows: hits } = await db.query(
    `SELECT x.kind, x.resource_id, o.session_id, o.weekday, lower(o.during) AS start_min, upper(o.during) AS end_min
       FROM unnest($2::text[], $3::uuid[], $4::int[], $5::int[], $6::int[]) AS x(kind, resource_id, weekday, start_min, end_min)
       JOIN planner_occupancy o
         ON o.version_id = $1
        AND o.kind = ANY (CASE x.kind WHEN 'room' THEN ARRAY['room', 'lab_room']
                                      WHEN 'lab_room' THEN ARRAY['room']
                                      ELSE ARRAY[x.kind] END)
        AND o.resource_id = x.resource_id AND o.weekday = x.weekday
        AND o.during && int4range(x.start_min, x.end_min, '[)')
      WHERE o.session_id <> $7`,
    [versionId, rows.map((r) => r.kind), rows.map((r) => r.resource_id), rows.map((r) => r.weekday),
      rows.map((r) => r.start_min), rows.map((r) => r.end_min), selfId]
  );
  const shared = await capacityConflicts(db, versionId, ctx, selfId, rows, need);
  if (!hits.length) return { conflicts: shared, capacity: shared.length > 0 };

  const holderIds = [...new Set(hits.map((h) => h.session_id))];
  const { rows: holderRows } = await db.query(
    `SELECT s.id, sub.code AS subject_code, sub.name AS subject_name, d.name AS division_name, d.semester,
            b.name AS batch_name, b.is_whole
       FROM planner_sessions s
       JOIN planner_offerings o ON o.id = s.offering_id
       JOIN planner_subjects sub ON sub.id = o.subject_id
       JOIN planner_divisions d ON d.id = o.division_id
       JOIN planner_batches b ON b.id = s.batch_id
      WHERE s.id = ANY($1::uuid[])`,
    [holderIds]
  );
  const holders = new Map(holderRows.map((h) => [h.id, h]));
  const facultyIds = [...new Set(hits.filter((h) => h.kind === "faculty").map((h) => h.resource_id))];
  const facultyNames = new Map();
  if (facultyIds.length) {
    const { rows: fr } = await db.query("SELECT id, full_name, short_code FROM planner_faculty WHERE id = ANY($1::uuid[])", [facultyIds]);
    for (const f of fr) facultyNames.set(f.id, `${f.full_name} (${f.short_code})`);
  }
  const nameOf = (kind, id) => {
    if (kind === "faculty") return facultyNames.get(id) ?? "This faculty member";
    if (kind === "room") return ctx.roomsById.get(id)?.name ?? "this room";
    const info = ctx.batchInfo.get(id);
    if (!info) return "This class";
    const div = `${info.division.name} (Sem ${info.division.semester})`;
    return info.batch.is_whole ? div : `${div} batch ${info.batch.name}`;
  };

  const out = [];
  const seen = new Set();
  for (const h of hits) {
    const holder = holders.get(h.session_id);
    if (!holder) continue;
    const kind = h.kind === "lab_room" ? "room" : h.kind; // the response never exposes the shared kind
    const resource_name = nameOf(kind, h.resource_id);
    const text = describeConflict({
      kind, resourceName: resource_name, holder, weekday: h.weekday, start_min: h.start_min, end_min: h.end_min,
    });
    // a whole-division holder overlaps several batch rows of the same session: one sentence is enough
    const key = `${kind}|${h.session_id}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, resource_id: h.resource_id, resource_name, session_id: h.session_id, text });
  }
  out.push(...shared);
  out.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  return { conflicts: out, capacity: shared.length > 0 };
}

/**
 * Replaces a session's occupancy rows by the rows of `next` (a session-like object), clash-checked.
 * Throws 409 CLASH (listing every conflict) when another session holds any of the resources.
 */
async function rewriteOccupancy(db, versionId, ctx, opIndex, session, next) {
  const division = ctx.divisions.get(session.division_id);
  // The room row kind is decided HERE (not per op) so every rewrite - move, set_room, set_faculty - keeps it right.
  const shared_room = isShareable({ subject: ctx.subjects.get(session.subject_id), poolRoom: ctx.roomsById.get(next.room_id) });
  const rows = occupancyRows({
    session: { id: session.id, batch_id: session.batch_id, ...next, shared_room, faculty_ids: next.faculty_ids },
    division,
  });
  await db.query("DELETE FROM planner_occupancy WHERE session_id = $1", [session.id]);
  const need = studentsFor({ batch: division.batches.find((x) => x.id === session.batch_id), division });
  const { conflicts, capacity } = await findConflicts(db, versionId, ctx, session.id, rows, need);
  if (conflicts.length) {
    if (capacity) throw new PlannerError(409, "CLASH", conflicts[0].text, { op_index: opIndex, conflicts, reason: "ROOM_CAPACITY" });
    throw clash(conflicts, opIndex);
  }
  if (rows.length) {
    await db.query(
      `INSERT INTO planner_occupancy (version_id, session_id, kind, resource_id, weekday, during)
       SELECT $1, $2, t.kind, t.resource_id, t.weekday, int4range(t.start_min, t.end_min, '[)')
         FROM unnest($3::text[], $4::uuid[], $5::int[], $6::int[], $7::int[]) AS t(kind, resource_id, weekday, start_min, end_min)`,
      [versionId, session.id, rows.map((r) => r.kind), rows.map((r) => r.resource_id), rows.map((r) => r.weekday),
        rows.map((r) => r.start_min), rows.map((r) => r.end_min)]
    );
  }
}

const requireUnlocked = (s, i) => {
  if (s.locked) throw sessionLocked(i);
};

/** place / move (place of a placed session behaves as move). Returns true when something changed. */
async function opPlace(db, version, ctx, i, op, s) {
  requireUnlocked(s, i);
  const subject = ctx.subjects.get(s.subject_id);
  const division = ctx.divisions.get(s.division_id);
  const batch = division.batches.find((b) => b.id === s.batch_id);
  const check = checkPlacement({
    term: ctx.term, subject, weekday: op.weekday, start_min: op.start_min, room_id: op.room_id ?? undefined, poolRoomIds: ctx.poolRoomIds,
  });
  if (!check.ok) throw placementInvalid(check.message, check.reason, i);

  let roomId = op.room_id ?? null;
  if (!roomId) {
    const roomLoads = await roomLoadsAt(db, version.id, op.weekday, op.start_min, check.end_min, s.id);
    const pick = pickRoom({
      subject, division, batch, poolRooms: ctx.poolRooms, roomLoads, currentRoomId: isPlaced(s) ? s.room_id : null,
    });
    if (!pick.room_id) throw noRoomAvailable(pick.reason, i);
    roomId = pick.room_id;
  }
  const next = { weekday: op.weekday, start_min: op.start_min, end_min: check.end_min, room_id: roomId, faculty_ids: s.faculty_ids };
  if (isPlaced(s) && sameSlot(s, next)) return false;

  await rewriteOccupancy(db, version.id, ctx, i, s, next);
  await db.query(
    "UPDATE planner_sessions SET weekday = $2, start_min = $3, end_min = $4, room_id = $5 WHERE id = $1",
    [s.id, next.weekday, next.start_min, next.end_min, next.room_id]
  );
  Object.assign(s, { weekday: next.weekday, start_min: next.start_min, end_min: next.end_min, room_id: next.room_id });
  return true;
}

async function opUnplace(db, i, s) {
  requireUnlocked(s, i);
  if (!isPlaced(s)) return false;
  await db.query("DELETE FROM planner_occupancy WHERE session_id = $1", [s.id]);
  await db.query("UPDATE planner_sessions SET weekday = NULL, start_min = NULL, end_min = NULL, room_id = NULL WHERE id = $1", [s.id]);
  Object.assign(s, { weekday: null, start_min: null, end_min: null, room_id: null });
  return true;
}

async function opLock(db, s, locked) {
  if (s.locked === locked) return false;
  await db.query("UPDATE planner_sessions SET locked = $2 WHERE id = $1", [s.id, locked]);
  s.locked = locked;
  return true;
}

async function opSetRoom(db, version, ctx, i, op, s) {
  requireUnlocked(s, i);
  if (!isPlaced(s)) {
    throw invalid("Place the session before choosing a room", { session_id: ["Place the session before choosing a room"] });
  }
  if (!ctx.poolRoomIds.has(op.room_id)) {
    throw placementInvalid("That room is not in this term's room pool.", "ROOM_NOT_IN_POOL", i);
  }
  if (s.room_id === op.room_id) return false;
  await rewriteOccupancy(db, version.id, ctx, i, s, { ...s, room_id: op.room_id });
  await db.query("UPDATE planner_sessions SET room_id = $2 WHERE id = $1", [s.id, op.room_id]);
  s.room_id = op.room_id;
  return true;
}

async function opSetFaculty(db, version, ctx, i, op, s) {
  requireUnlocked(s, i);
  const { rows } = await db.query("SELECT id FROM planner_faculty WHERE id = ANY($1::uuid[]) AND is_active", [op.faculty_ids]);
  const ok = new Set(rows.map((r) => r.id));
  if (op.faculty_ids.some((f) => !ok.has(f))) {
    throw invalid("Faculty member not found or inactive", { faculty_ids: ["faculty member not found or inactive"] });
  }
  const same = op.faculty_ids.length === s.faculty_ids.length && op.faculty_ids.every((f) => s.faculty_ids.includes(f));
  if (same) return false;
  if (isPlaced(s)) await rewriteOccupancy(db, version.id, ctx, i, s, { ...s, faculty_ids: op.faculty_ids });
  await db.query("DELETE FROM planner_session_faculty WHERE session_id = $1", [s.id]);
  await db.query(
    "INSERT INTO planner_session_faculty (session_id, faculty_id) SELECT $1, f FROM unnest($2::uuid[]) AS t(f)",
    [s.id, op.faculty_ids]
  );
  s.faculty_ids = op.faculty_ids;
  return true;
}

/**
 * Applies a batch of ops atomically (all or nothing) to a draft version. See the contract (section 8.2) for
 * the request/response shapes. Returns { rev, prev_rev, sessions (changed ones), results }.
 */
export async function applyOps(versionId, body /* , { actorId } */) {
  const b = parse(bodySchema, body);
  return withTransaction(async (db) => {
    // a stuck lock holder must not stall the request forever: waiting for the version row (or any row) longer
    // than this fails with 55P03, which the router answers as 409 CONFLICT_RETRY
    await db.query(`SET LOCAL lock_timeout = '${OPS_LOCK_TIMEOUT_MS}ms'`);
    const version = await getVersion(db, versionId, { lock: true });
    if (version.status !== "draft") throw notDraft();
    const prevRev = Number(version.rev);

    const ids = [...new Set(b.ops.map((o) => o.session_id))];
    const working = await loadWorkingSessions(db, version.id, ids);
    b.ops.forEach((o, i) => {
      if (!working.has(o.session_id)) throw new PlannerError(404, "NOT_FOUND", "Session not found in this version", { op_index: i });
    });
    const ctx = await loadContext(db, version);

    const changed = new Set();
    const results = [];
    for (const [i, op] of b.ops.entries()) {
      const s = working.get(op.session_id);
      let did;
      switch (op.op) {
        case "place":
        case "move": did = await opPlace(db, version, ctx, i, op, s); break;
        case "unplace": did = await opUnplace(db, i, s); break;
        case "lock": did = await opLock(db, s, true); break;
        case "unlock": did = await opLock(db, s, false); break;
        case "set_room": did = await opSetRoom(db, version, ctx, i, op, s); break;
        case "set_faculty": did = await opSetFaculty(db, version, ctx, i, op, s); break;
        default: throw invalid("Unknown op", { op: ["unknown op"] });
      }
      if (did) changed.add(s.id);
      results.push({ index: i, session_id: s.id, room_id: s.room_id ?? null });
    }

    if (!changed.size) return { rev: prevRev, prev_rev: prevRev, sessions: [], results };
    const { rows: [{ rev }] } = await db.query("UPDATE planner_versions SET rev = rev + 1 WHERE id = $1 RETURNING rev", [version.id]);
    const sessions = await loadSessions(db, version.id, { ids: [...changed] });
    return { rev: Number(rev), prev_rev: prevRev, sessions, results };
  });
}

// ------------------------------------------------------------------ applyPlacements (Phase 3, contract 9.5 + 9.9)

const MAX_PLACEMENTS_PER_CALL = 20000;
const MAX_UNPLACE_IDS = 20000;

/** Staleness guard: the slot a session must currently be in (null = must currently be unplaced). */
const expectSchema = z.object({ weekday, start_min: startMin, room_id: uuid.nullable() });
const placementSchema = z.object({
  session_id: uuid, weekday, start_min: startMin, room_id: uuid, expect: expectSchema.nullable().optional(),
});
const unplaceEntrySchema = z.union([
  uuid.transform((id) => ({ session_id: id })),
  z.object({ session_id: uuid, expect: expectSchema.nullable().optional() }),
]);

const placementsSchema = z.object({
  client_id: z.string().max(64, "must be at most 64 characters").nullish(),
  unplace_ids: z.array(unplaceEntrySchema).max(MAX_UNPLACE_IDS, `at most ${MAX_UNPLACE_IDS} sessions can be unplaced per call`)
    .transform((a) => {
      const seen = new Set();
      return a.filter((e) => (seen.has(e.session_id) ? false : (seen.add(e.session_id), true)));
    }).optional(),
  units: z.array(z.object({
    unit_id: z.string().min(1, "is required").max(64, "must be at most 64 characters"),
    placements: z.array(placementSchema).min(1, "a unit needs at least one placement"),
    // executed (same transaction) when the unit is refused; if it is refused too the sessions stay as they were
    fallback: z.array(placementSchema).min(1).optional(),
  })).max(MAX_PLACEMENTS_PER_CALL, "too many units"),
}).superRefine((b, ctx) => {
  const unitIds = new Set();
  const sessionIds = new Set();
  let total = 0;
  b.units.forEach((u, ui) => {
    if (unitIds.has(u.unit_id)) ctx.addIssue({ code: "custom", path: ["units", ui, "unit_id"], message: "unit ids must be unique" });
    unitIds.add(u.unit_id);
    u.placements.forEach((p, pi) => {
      total++;
      if (sessionIds.has(p.session_id)) {
        ctx.addIssue({ code: "custom", path: ["units", ui, "placements", pi, "session_id"], message: "a session can only be placed once per call" });
      }
      sessionIds.add(p.session_id);
    });
  });
  if (total > MAX_PLACEMENTS_PER_CALL) {
    ctx.addIssue({ code: "custom", path: ["units"], message: `at most ${MAX_PLACEMENTS_PER_CALL} placements per call` });
  }
});

/** Packs units into chunks of about `chunk` placements; a unit is never split (an oversized unit gets its own chunk). */
function packChunks(units, chunk) {
  const out = [];
  let cur = null;
  let size = 0;
  for (const u of units) {
    const n = u.placements.length;
    if (!cur || (size > 0 && size + n > chunk)) {
      cur = [];
      size = 0;
      out.push(cur);
    }
    cur.push(u);
    size += n;
  }
  return out;
}

const SLOT_FIELDS = ["weekday", "start_min", "end_min", "room_id"];

/** Does the session currently sit exactly where `expect` says (null: must be unplaced)? */
function matchesExpect(s, expect) {
  if (expect === null) return !isPlaced(s);
  return isPlaced(s) && s.weekday === expect.weekday && s.start_min === expect.start_min && (s.room_id ?? null) === (expect.room_id ?? null);
}

/**
 * Bulk commit path used by the generator, "regenerate" and undo (contract 9.5, 9.9). Writes through the SAME checks as
 * the /ops `place` op (opPlace -> checkPlacement, rewriteOccupancy incl. clash + shared-lab capacity), with an explicit
 * room per placement. Units are all-or-nothing (one SAVEPOINT each); chunks (one transaction, one rev bump each)
 * never split a unit. Does NOT emit sockets.
 *
 * body: { client_id?,
 *         unplace_ids?: (uuid | {session_id, expect?})[],
 *         units: [{ unit_id (<= 64 chars), placements: [{ session_id, weekday, start_min, room_id, expect? }], fallback?: placements[] }] }
 *   expect = {weekday, start_min, room_id} the session must currently be in, or null = must currently be unplaced
 *   (undefined = no check). A placement whose expect does not hold refuses its unit with code 'STALE'; an unplace whose
 *   expect does not hold is skipped and listed in `skipped_stale`. `fallback` placements run (same transaction) when the
 *   unit itself was refused; the refusal entry then says fallback_applied true/false.
 * opts: { chunk = 100, atomic = false,   (atomic: ONE chunk/transaction/rev bump whatever the size, also when empty)
 *         onChunk?: async ({chunk_index, chunks, rev, applied_units, refused_units, sessions}) => void,
 *         isCancelled?: () => boolean | Promise<boolean>,   (checked before every chunk; when true the call stops and returns what is committed)
 *         guard?: async (db, version) => void,       (inside each chunk's transaction after the version lock + draft check; may throw)
 *         finalize?: async (db, {rev, prev_rev, sessions}) => void }  (inside the chunk's transaction, before COMMIT)
 * returns { rev, prev_rev, applied_units: string[], refused_units: [{unit_id, code, message, op_index, fallback_applied?}],
 *           skipped_locked: string[], skipped_stale: string[], sessions: [changed sessions, de-duplicated, last state wins],
 *           chunks, cancelled }
 *   chunks = chunks committed; the onChunk `chunks` is the planned total; onChunk `sessions` = the sessions THAT chunk changed.
 * Throws (aborting the call; earlier chunks stay committed) on NOT_FOUND/NOT_DRAFT and on any non-planner error.
 */
export async function applyPlacements(versionId, body, opts = {}) {
  const b = parse(placementsSchema, body);
  const chunkSize = Number.isInteger(opts.chunk) && opts.chunk >= 1 ? opts.chunk : 100;
  const { onChunk, isCancelled, guard, finalize } = opts;
  const unplaceEntries = b.unplace_ids ?? [];

  let groups;
  if (opts.atomic) groups = [b.units];
  else {
    groups = packChunks(b.units, chunkSize);
    if (!groups.length && unplaceEntries.length) groups.push([]);
  }
  const total = groups.length;

  const applied = [];
  const refused = [];
  const skippedLocked = [];
  const skippedStale = [];
  const sessionsById = new Map();
  let prevRev = null;
  let rev = null;
  let done = 0;
  let cancelled = false;
  let savepointNo = 0;

  for (let ci = 0; ci < total; ci++) {
    if (await isCancelled?.()) {
      cancelled = true;
      break;
    }
    const units = groups[ci];
    const unplaceNow = ci === 0 ? unplaceEntries : [];
    const chunkApplied = [];
    const chunkRefused = [];

    const result = await withTransaction(async (db) => {
      await db.query(`SET LOCAL lock_timeout = '${OPS_LOCK_TIMEOUT_MS}ms'`);
      const version = await getVersion(db, versionId, { lock: true });
      if (version.status !== "draft") throw notDraft();
      if (guard) await guard(db, version);
      const chunkPrevRev = Number(version.rev);

      const ids = [...new Set([
        ...unplaceNow.map((e) => e.session_id),
        ...units.flatMap((u) => [...u.placements, ...(u.fallback ?? [])].map((p) => p.session_id)),
      ])];
      const working = await loadWorkingSessions(db, version.id, ids);
      unplaceNow.forEach((e, i) => {
        if (!working.has(e.session_id)) throw new PlannerError(404, "NOT_FOUND", "Session not found in this version", { op_index: i });
      });
      const ctx = await loadContext(db, version);

      const changed = new Set();
      const locked = [];
      const stale = [];
      for (const [i, e] of unplaceNow.entries()) {
        const s = working.get(e.session_id);
        if (s.locked) {
          locked.push(e.session_id);
          continue;
        }
        if (e.expect !== undefined && !matchesExpect(s, e.expect)) {
          stale.push(e.session_id);
          continue;
        }
        if (await opUnplace(db, i, s)) changed.add(e.session_id);
      }

      /** One all-or-nothing try of a list of placements inside a savepoint -> {ok} | {ok:false, code, message, op_index}. */
      const attempt = async (placements) => {
        const sp = `u_${++savepointNo}`;
        const touched = placements.map((p) => working.get(p.session_id));
        const before = touched.map((s) => (s ? Object.fromEntries(SLOT_FIELDS.map((f) => [f, s[f]])) : null));
        const unitChanged = [];
        await db.query(`SAVEPOINT ${sp}`);
        let idx = 0;
        try {
          for (; idx < placements.length; idx++) {
            const p = placements[idx];
            const s = working.get(p.session_id);
            if (!s) throw new PlannerError(404, "NOT_FOUND", "Session not found in this version", { op_index: idx });
            if (p.expect !== undefined && !matchesExpect(s, p.expect)) {
              throw new PlannerError(409, "STALE", "The session was changed by someone else in the meantime.", { op_index: idx });
            }
            if (await opPlace(db, version, ctx, idx, { weekday: p.weekday, start_min: p.start_min, room_id: p.room_id }, s)) {
              unitChanged.push(s.id);
            }
          }
          await db.query(`RELEASE SAVEPOINT ${sp}`);
          unitChanged.forEach((id) => changed.add(id));
          return { ok: true };
        } catch (err) {
          // the exclusion constraint is only a backstop behind the pre-check; the savepoint makes it recoverable
          const isBackstop = err?.code === "23P01";
          if (!(err instanceof PlannerError) && !isBackstop) throw err;
          await db.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          await db.query(`RELEASE SAVEPOINT ${sp}`);
          touched.forEach((s, k) => {
            if (s) Object.assign(s, before[k]);
          });
          return {
            ok: false,
            code: isBackstop ? "CLASH" : err.code,
            message: isBackstop ? "That slot was just taken by another change." : err.message,
            op_index: idx,
          };
        }
      };

      for (const u of units) {
        const r = await attempt(u.placements);
        if (r.ok) {
          chunkApplied.push(u.unit_id);
          continue;
        }
        const entry = { unit_id: u.unit_id, code: r.code, message: r.message, op_index: r.op_index };
        if (u.fallback) entry.fallback_applied = (await attempt(u.fallback)).ok;
        chunkRefused.push(entry);
      }

      let newRev = chunkPrevRev;
      let sessions = [];
      if (changed.size) {
        const { rows: [{ rev: r }] } = await db.query("UPDATE planner_versions SET rev = rev + 1 WHERE id = $1 RETURNING rev", [version.id]);
        newRev = Number(r);
        sessions = await loadSessions(db, version.id, { ids: [...changed] });
      }
      if (finalize) await finalize(db, { rev: newRev, prev_rev: chunkPrevRev, sessions });
      return { chunkPrevRev, newRev, sessions, locked, stale };
    });

    prevRev ??= result.chunkPrevRev;
    rev = result.newRev;
    done++;
    applied.push(...chunkApplied);
    refused.push(...chunkRefused);
    skippedLocked.push(...result.locked);
    skippedStale.push(...result.stale);
    for (const s of result.sessions) sessionsById.set(s.id, s);
    if (onChunk) {
      await onChunk({
        chunk_index: ci, chunks: total, rev, applied_units: chunkApplied, refused_units: chunkRefused, sessions: result.sessions,
      });
    }
  }

  if (rev === null) {
    // nothing ran (empty body or cancelled before the first chunk): report the current rev
    rev = Number((await getVersion(pool, versionId)).rev);
    prevRev = rev;
  }
  return {
    rev, prev_rev: prevRev, applied_units: applied, refused_units: refused, skipped_locked: skippedLocked, skipped_stale: skippedStale,
    sessions: [...sessionsById.values()], chunks: done, cancelled,
  };
}
