import { placedSessions, lockedByPlacements } from "./errors.js";

/**
 * Locks every version row of a term (id order, so two lockers cannot deadlock). Editor ops lock their version
 * row first thing, so taking the same lock serialises a structural change (new batch, subject duration, term hours,
 * pool room edits, deleting offerings...) against any placement that is in flight. Call it BEFORE reading
 * anything the decision depends on (placed-session counts), inside the transaction that then writes.
 */
export async function lockTermVersions(db, termId) {
  await db.query("SELECT id FROM planner_versions WHERE term_id = $1 ORDER BY id FOR UPDATE", [termId]);
}

// Which sessions belong to a thing about to be deleted. $1 is always its id.
const SCOPES = {
  division: `(offering_id IN (SELECT id FROM planner_offerings WHERE division_id = $1)
              OR batch_id IN (SELECT id FROM planner_batches WHERE division_id = $1))`,
  offering: "offering_id = $1",
  batch: "batch_id = $1",
};

const countPlaced = async (db, where, id) =>
  (await db.query(`SELECT count(*)::int AS placed FROM planner_sessions WHERE ${where} AND weekday IS NOT NULL`, [id])).rows[0].placed;

/**
 * Deletes the unplaced sessions (in every version of the term) of a division / offering / batch so the
 * thing itself can be deleted (sessions reference them with NO ACTION). Takes the term's version locks first.
 * Throws 409 HAS_PLACED_SESSIONS, deleting nothing, if any of those sessions is placed on the grid; the delete
 * itself only matches `weekday IS NULL`, and a second check afterwards makes sure no placed session is left
 * for the scope (the caller's transaction rolls back if that ever fires).
 * When sessions were deleted, the rev of every DRAFT version that held some is bumped once.
 * Must run inside the transaction that then deletes the parent.
 *
 * Returns [{ version_id, prev_rev, rev }] for the bumped versions (empty when nothing was deleted) so the
 * route can emit `planner:changed` after COMMIT.
 */
export async function removeUnplacedSessions(db, termId, scope, id, label) {
  const where = SCOPES[scope];
  await lockTermVersions(db, termId);
  const placed = await countPlaced(db, where, id);
  const refuse = (n) =>
    placedSessions(`${label} has ${n} session${n === 1 ? "" : "s"} placed on the timetable. Unplace them first.`, { placed: n });
  if (placed > 0) throw refuse(placed);

  const { rows: deleted } = await db.query(`DELETE FROM planner_sessions WHERE ${where} AND weekday IS NULL RETURNING version_id`, [id]);

  const stillPlaced = await countPlaced(db, where, id);
  if (stillPlaced > 0) throw refuse(stillPlaced);

  if (!deleted.length) return [];
  const versionIds = [...new Set(deleted.map((r) => r.version_id))];
  const { rows } = await db.query(
    `UPDATE planner_versions SET rev = rev + 1 WHERE id = ANY($1::uuid[]) AND status = 'draft' RETURNING id, rev`,
    [versionIds]
  );
  return rows
    .map((r) => ({ version_id: r.id, prev_rev: Number(r.rev) - 1, rev: Number(r.rev) }))
    .sort((a, b) => (a.version_id < b.version_id ? -1 : 1));
}

/**
 * Placed sessions (any version) of the given scope whose room row is a shared lab_room row. Used to refuse
 * student-count edits that would silently over-fill a shared lab. scope: "division" (its whole-batch sessions, the only ones that use the division's count) or "batch".
 * Callers hold lockTermVersions.
 */
export async function countPlacedSharedLabSessions(db, scope, id) {
  // a division's own sessions are the whole-batch ones: only they take their student count from the division
  const batchFilter = scope === "division" ? "s.batch_id IN (SELECT id FROM planner_batches WHERE division_id = $1 AND is_whole)" : "s.batch_id = $1";
  const { rows: [{ n }] } = await db.query(
    `SELECT count(DISTINCT s.id)::int AS n
       FROM planner_sessions s JOIN planner_occupancy o ON o.session_id = s.id AND o.kind = 'lab_room'
      WHERE s.weekday IS NOT NULL AND ${batchFilter}`,
    [id]
  );
  return n;
}

/** 409 LOCKED_BY_PLACEMENTS for a student-count edit; `label` is e.g. "Division CSE-A" or "Batch A1". */
export function studentCountLocked(label, n, field = "student_count") {
  return lockedByPlacements(
    `${label} has lab sessions placed in a shared lab room, so its student count cannot change. Unplace them first.`,
    { fields: [field], placed: n }
  );
}
