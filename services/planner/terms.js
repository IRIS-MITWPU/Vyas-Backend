import { z } from "zod";
import { pool, withTransaction } from "./tx.js";
import { parse, failField, text, int, dateStr, uuid } from "./validate.js";
import { notFound, orDuplicate, PlannerError, lockedByPlacements, buildingChangeNeedsConfirm } from "./errors.js";
import { lockTermVersions } from "./guards.js";
import { DEFAULT_TERM_SETTINGS, DEFAULT_RULES } from "./domain/index.js";

// Dates are returned as 'YYYY-MM-DD' strings (node-pg would turn DATE into a local-midnight Date).
export const TERM_COLS = `t.id, t.academic_year, t.half, t.branch,
  to_char(t.start_date, 'YYYY-MM-DD') AS start_date, to_char(t.end_date, 'YYYY-MM-DD') AS end_date,
  t.working_days, t.day_start_min, t.day_end_min, t.grid_minutes, t.theory_minutes, t.lab_minutes,
  t.breaks, t.building_id, t.created_by, t.created_at, t.updated_at`;

// Changing any of these while a session is placed would invalidate the placement.
const LOCKED_KEYS = ["working_days", "day_start_min", "day_end_min", "grid_minutes", "theory_minutes", "lab_minutes", "breaks"];

const breakSchema = z.object({
  start_min: int(0, 1440),
  end_min: int(0, 1440),
  label: z.string().trim().max(80).optional(),
});
const termFields = {
  academic_year: text(40),
  half: z.enum(["odd", "even"], { error: "must be odd or even" }),
  branch: text(40),
  start_date: dateStr.nullable().optional(),
  end_date: dateStr.nullable().optional(),
  working_days: z.array(int(0, 6)).min(1, "needs at least one working day"),
  day_start_min: int(0, 1440),
  day_end_min: int(0, 1440),
  grid_minutes: int(1, 1440),
  theory_minutes: int(1, 1440),
  lab_minutes: int(1, 1440),
  breaks: z.array(breakSchema).max(20),
  building_id: uuid.nullable(), // contract 10.2: the building the timetable is for (null = no restriction)
};
const createSchema = z.object({
  ...termFields,
  branch: termFields.branch.optional(),
  working_days: termFields.working_days.optional(),
  day_start_min: termFields.day_start_min.optional(),
  day_end_min: termFields.day_end_min.optional(),
  grid_minutes: termFields.grid_minutes.optional(),
  theory_minutes: termFields.theory_minutes.optional(),
  lab_minutes: termFields.lab_minutes.optional(),
  breaks: termFields.breaks.optional(),
  building_id: termFields.building_id.optional(),
});
// confirm_unplace is not a column: it authorises removing rooms / placements outside a newly chosen building (10.2)
const patchSchema = z.object({ ...termFields, confirm_unplace: z.boolean().optional() }).partial();

/** Cross-field rules on a complete (merged) term. Throws 400 VALIDATION_ERROR. */
function checkTerm(t) {
  if (t.day_start_min >= t.day_end_min) failField("day_end_min", "must be later than day_start_min");
  if (t.start_date && t.end_date && t.start_date > t.end_date) failField("end_date", "must not be before start_date");
  for (const [i, b] of (t.breaks || []).entries()) {
    if (b.start_min >= b.end_min) failField(`breaks.${i}.end_min`, "must be later than start_min");
  }
}

/** Field error unless the building exists and is active. */
async function assertBuilding(db, buildingId, field = "building_id") {
  const { rows } = await db.query("SELECT is_active FROM buildings WHERE id = $1", [buildingId]);
  if (!rows[0]) failField(field, "building not found");
  if (rows[0].is_active === false) failField(field, "this building is not active");
}

const sortedDays = (d) => [...new Set(d)].sort((a, b) => a - b);

/** Breaks compared by meaning: jsonb does not keep key order, and the order of the breaks is irrelevant. */
const canonicalBreaks = (breaks) =>
  JSON.stringify(
    (Array.isArray(breaks) ? breaks : [])
      .map((b) => [Number(b?.start_min), Number(b?.end_min), String(b?.label ?? "").trim()])
      .sort((x, y) => x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0))
  );

async function getTermRow(db, id, { lock = false } = {}) {
  const { rows } = await db.query(`SELECT ${TERM_COLS} FROM planner_terms t WHERE t.id = $1 ${lock ? "FOR UPDATE OF t" : ""}`, [id]);
  if (!rows[0]) throw notFound("Term not found");
  return rows[0];
}

/** Loads a term (404 when missing). Other services use this to scope their queries. */
export const requireTerm = (db, id, opts) => getTermRow(db, id, opts);

export async function listTerms() {
  const { rows } = await pool.query(
    `SELECT ${TERM_COLS},
       (SELECT v.id FROM planner_versions v WHERE v.term_id = t.id AND v.status = 'draft') AS draft_version_id,
       jsonb_build_object(
         'divisions', (SELECT count(*)::int FROM planner_divisions d WHERE d.term_id = t.id),
         'subjects',  (SELECT count(*)::int FROM planner_subjects s WHERE s.term_id = t.id),
         'offerings', (SELECT count(*)::int FROM planner_offerings o JOIN planner_divisions d ON d.id = o.division_id WHERE d.term_id = t.id),
         'rooms',     (SELECT count(*)::int FROM planner_term_rooms r WHERE r.term_id = t.id),
         'sessions',  (SELECT count(*)::int FROM planner_sessions ps JOIN planner_versions v ON v.id = ps.version_id WHERE v.term_id = t.id)
       ) AS counts
     FROM planner_terms t
     ORDER BY t.academic_year DESC, t.half DESC, t.branch`
  );
  return rows;
}

export async function getTerm(id) {
  const term = await getTermRow(pool, id);
  const { rows: versions } = await pool.query(
    `SELECT id, term_id, version_no, status, based_on_id, rev, published_at, published_by, created_at
       FROM planner_versions WHERE term_id = $1 ORDER BY version_no`,
    [id]
  );
  return { term, versions, draft_version_id: versions.find((v) => v.status === "draft")?.id ?? null };
}

export async function createTerm(body, userId) {
  const b = parse(createSchema, body);
  const term = {
    academic_year: b.academic_year,
    half: b.half,
    branch: b.branch ?? DEFAULT_TERM_SETTINGS.branch,
    start_date: b.start_date ?? null,
    end_date: b.end_date ?? null,
    working_days: sortedDays(b.working_days ?? DEFAULT_TERM_SETTINGS.working_days),
    day_start_min: b.day_start_min ?? DEFAULT_TERM_SETTINGS.day_start_min,
    day_end_min: b.day_end_min ?? DEFAULT_TERM_SETTINGS.day_end_min,
    grid_minutes: b.grid_minutes ?? DEFAULT_TERM_SETTINGS.grid_minutes,
    theory_minutes: b.theory_minutes ?? DEFAULT_TERM_SETTINGS.theory_minutes,
    lab_minutes: b.lab_minutes ?? DEFAULT_TERM_SETTINGS.lab_minutes,
    breaks: b.breaks ?? DEFAULT_TERM_SETTINGS.breaks,
    building_id: b.building_id ?? null,
  };
  checkTerm(term);

  return orDuplicate("A term for this academic year, half and branch already exists", () =>
    withTransaction(async (db) => {
      if (term.building_id) await assertBuilding(db, term.building_id);
      const { rows: [{ id }] } = await db.query(
        `INSERT INTO planner_terms (academic_year, half, branch, start_date, end_date, working_days,
           day_start_min, day_end_min, grid_minutes, theory_minutes, lab_minutes, breaks, building_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14) RETURNING id`,
        [term.academic_year, term.half, term.branch, term.start_date, term.end_date, term.working_days,
          term.day_start_min, term.day_end_min, term.grid_minutes, term.theory_minutes, term.lab_minutes,
          JSON.stringify(term.breaks), term.building_id, userId ?? null]
      );
      const { rows: [version] } = await db.query(
        `INSERT INTO planner_versions (term_id, version_no, status) VALUES ($1, 1, 'draft')
         RETURNING id, term_id, version_no, status, based_on_id, rev, published_at, published_by, created_at`,
        [id]
      );
      await db.query(
        `INSERT INTO planner_rule_config (term_id, rule_key, enabled, severity, weight, params)
         SELECT $1, x.rule_key, x.enabled, x.severity, x.weight, x.params
           FROM jsonb_to_recordset($2::jsonb) AS x(rule_key text, enabled boolean, severity text, weight int, params jsonb)`,
        [id, JSON.stringify(DEFAULT_RULES)]
      );
      return { term: await getTermRow(db, id), version };
    })
  );
}

/**
 * Rooms and placements outside `buildingId` (contract 10.2): the term's pool rooms, the placed sessions (any version) whose
 * room is in another building (locked ones counted apart) and the divisions whose home rooms are in another building.
 */
async function outsideBuilding(db, termId, buildingId) {
  const { rows: poolRooms } = await db.query(
    `SELECT tr.room_id FROM planner_term_rooms tr JOIN rooms r ON r.id = tr.room_id JOIN floors f ON f.id = r.floor_id
      WHERE tr.term_id = $1 AND f.building_id <> $2`,
    [termId, buildingId]
  );
  const { rows: sessions } = await db.query(
    `SELECT s.id, s.version_id, s.locked FROM planner_sessions s
       JOIN planner_versions v ON v.id = s.version_id
       JOIN rooms r ON r.id = s.room_id JOIN floors f ON f.id = r.floor_id
      WHERE v.term_id = $1 AND s.weekday IS NOT NULL AND f.building_id <> $2`,
    [termId, buildingId]
  );
  const { rows: divisions } = await db.query(
    `SELECT d.id, d.home_room_id, d.home_room2_id,
            (SELECT f.building_id FROM rooms r JOIN floors f ON f.id = r.floor_id WHERE r.id = d.home_room_id) AS b1,
            (SELECT f.building_id FROM rooms r JOIN floors f ON f.id = r.floor_id WHERE r.id = d.home_room2_id) AS b2
       FROM planner_divisions d WHERE d.term_id = $1`,
    [termId]
  );
  return {
    poolRoomIds: poolRooms.map((r) => r.room_id),
    sessions,
    divisions: divisions.filter((d) => (d.home_room_id && d.b1 !== buildingId) || (d.home_room2_id && d.b2 !== buildingId)),
    buildingId,
  };
}

/**
 * Removes what lies outside the new building, in the caller's transaction: unplaces the sessions (occupancy rows
 * deleted), bumps the rev of the affected draft versions, drops the outside pool rooms and clears outside home rooms.
 * Returns the rev bumps [{version_id, prev_rev, rev}] for the route to emit after COMMIT.
 */
async function removeOutsideBuilding(db, termId, out) {
  let bumps = [];
  if (out.sessions.length) {
    const ids = out.sessions.map((s) => s.id);
    await db.query("DELETE FROM planner_occupancy WHERE session_id = ANY($1::uuid[])", [ids]);
    await db.query("UPDATE planner_sessions SET weekday = NULL, start_min = NULL, end_min = NULL, room_id = NULL WHERE id = ANY($1::uuid[])", [ids]);
    const versionIds = [...new Set(out.sessions.map((s) => s.version_id))];
    const { rows } = await db.query(
      "UPDATE planner_versions SET rev = rev + 1 WHERE id = ANY($1::uuid[]) AND status = 'draft' RETURNING id, rev",
      [versionIds]
    );
    bumps = rows.map((r) => ({ version_id: r.id, prev_rev: Number(r.rev) - 1, rev: Number(r.rev) })).sort((a, b) => (a.version_id < b.version_id ? -1 : 1));
  }
  if (out.poolRoomIds.length) {
    await db.query("DELETE FROM planner_term_rooms WHERE term_id = $1 AND room_id = ANY($2::uuid[])", [termId, out.poolRoomIds]);
  }
  for (const d of out.divisions) {
    const keep = [
      d.home_room_id && d.b1 === out.buildingId ? d.home_room_id : null,
      d.home_room2_id && d.b2 === out.buildingId ? d.home_room2_id : null,
    ].filter(Boolean);
    await db.query("UPDATE planner_divisions SET home_room_id = $2, home_room2_id = $3 WHERE id = $1", [d.id, keep[0] ?? null, keep[1] ?? null]);
  }
  return bumps;
}

export async function updateTerm(id, body) {
  return (await updateTermWithBumps(id, body)).term;
}

/** updateTerm that also returns the rev bumps of a building change (for planner:changed emits after commit). */
export async function updateTermWithBumps(id, body) {
  const { confirm_unplace: confirmUnplace, ...patch } = parse(patchSchema, body);
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!keys.length) failField("_", "No fields to update");
  for (const k of ["academic_year", "half", "branch", "working_days", "day_start_min", "day_end_min", "grid_minutes", "theory_minutes", "lab_minutes", "breaks"]) {
    if (patch[k] === null) failField(k, "cannot be empty");
  }

  return orDuplicate("A term for this academic year, half and branch already exists", () =>
    withTransaction(async (db) => {
      const current = await getTermRow(db, id, { lock: true });
      const merged = { ...current, ...patch };
      if (patch.working_days) merged.working_days = sortedDays(patch.working_days);
      checkTerm(merged);

      const changedLocked = LOCKED_KEYS.filter((k) => {
        if (!(k in patch)) return false;
        if (k === "working_days") return JSON.stringify(sortedDays(current.working_days)) !== JSON.stringify(merged.working_days);
        if (k === "breaks") return canonicalBreaks(current.breaks) !== canonicalBreaks(patch.breaks);
        return current[k] !== patch[k];
      });
      const buildingChanged = patch.building_id !== undefined && patch.building_id !== current.building_id;
      if (changedLocked.length || buildingChanged) {
        // serialise against placements in flight: an editor op holds its version row lock until it commits,
        // so the counts below can no longer miss a session that is being placed right now
        await lockTermVersions(db, id);
      }
      if (changedLocked.length) {
        const { rows: [{ placed }] } = await db.query(
          `SELECT count(*)::int AS placed FROM planner_sessions s
             JOIN planner_versions v ON v.id = s.version_id
            WHERE v.term_id = $1 AND s.weekday IS NOT NULL`,
          [id]
        );
        if (placed > 0) {
          throw new PlannerError(409, "LOCKED_BY_PLACEMENTS",
            "These settings cannot change while sessions are placed on the timetable. Unplace them first.",
            { fields: changedLocked, placed });
        }
      }

      // contract 10.2: a new building. Nothing to check when it is cleared (no restriction).
      let bumps = [];
      if (buildingChanged && patch.building_id) {
        await assertBuilding(db, patch.building_id);
        const out = await outsideBuilding(db, id, patch.building_id);
        const locked = out.sessions.filter((s) => s.locked).length;
        if (locked > 0) {
          throw lockedByPlacements(
            "Locked sessions are placed in rooms of another building. Unlock and unplace them before changing the building.",
            { fields: ["building_id"], locked }
          );
        }
        const something = out.poolRoomIds.length || out.sessions.length || out.divisions.length;
        if (something && !confirmUnplace) {
          throw buildingChangeNeedsConfirm({ rooms: out.poolRoomIds.length, placed_sessions: out.sessions.length, divisions: out.divisions.length });
        }
        if (something) bumps = await removeOutsideBuilding(db, id, out);
      }

      const sets = [];
      const vals = [id];
      for (const k of keys) {
        vals.push(k === "working_days" ? merged.working_days : k === "breaks" ? JSON.stringify(patch.breaks) : patch[k]);
        sets.push(`${k} = $${vals.length}${k === "breaks" ? "::jsonb" : ""}`);
      }
      await db.query(`UPDATE planner_terms SET ${sets.join(", ")} WHERE id = $1`, vals);
      return { term: await getTermRow(db, id), bumps };
    })
  );
}

/** Deletes a term and everything under it (FK cascades). Faculty (global) is untouched. */
export async function deleteTerm(id) {
  const { rows } = await pool.query(
    `DELETE FROM planner_terms WHERE id = $1 RETURNING id, academic_year, half, branch`,
    [id]
  );
  if (!rows[0]) throw notFound("Term not found");
  return rows[0];
}
