import { z } from "zod";
import { pool, withTransaction } from "./tx.js";
import { parse, failField, text, intIn, optIntIn } from "./validate.js";
import { LIMITS } from "./domain/limits.js";
import { notFound, inUse, duplicate, orDuplicate, lockedByPlacements } from "./errors.js";
import { lockTermVersions } from "./guards.js";
import { requireTerm } from "./terms.js";
import { defaultDurationFor } from "./domain/index.js";

const kind = z.enum(["theory", "lab"], { error: "must be theory or lab" });
const createSchema = z.object({
  code: text(LIMITS.subject_code),
  name: text(LIMITS.subject_name),
  kind,
  duration_min: intIn(LIMITS.duration_min).optional(),
  weekly_count: intIn(LIMITS.weekly_count),
  semester_total: optIntIn(LIMITS.semester_total),
  allow_second_lab: z.boolean().optional(),
});
const patchSchema = z.object({
  code: text(LIMITS.subject_code),
  name: text(LIMITS.subject_name),
  kind,
  duration_min: intIn(LIMITS.duration_min),
  weekly_count: intIn(LIMITS.weekly_count),
  semester_total: optIntIn(LIMITS.semester_total),
  allow_second_lab: z.boolean(),
}).partial();

const COLS = "id, term_id, code, name, kind, duration_min, weekly_count, semester_total, allow_second_lab";

export async function listSubjects(termId) {
  await requireTerm(pool, termId);
  const { rows } = await pool.query(`SELECT ${COLS} FROM planner_subjects WHERE term_id = $1 ORDER BY lower(code)`, [termId]);
  return rows;
}

async function getSubject(termId, sid) {
  const { rows } = await pool.query(`SELECT ${COLS} FROM planner_subjects WHERE id = $1 AND term_id = $2`, [sid, termId]);
  if (!rows[0]) throw notFound("Subject not found");
  return rows[0];
}

async function assertCodeFree(termId, code, exceptId = null) {
  const { rows } = await pool.query(
    "SELECT 1 FROM planner_subjects WHERE term_id = $1 AND lower(code) = lower($2) AND id IS DISTINCT FROM $3",
    [termId, code, exceptId]
  );
  if (rows.length) throw duplicate("A subject with this code already exists in this term");
}

export async function createSubject(termId, body) {
  const term = await requireTerm(pool, termId);
  const b = parse(createSchema, body);
  await assertCodeFree(termId, b.code);
  const duration = b.duration_min ?? defaultDurationFor(b.kind, term);
  const { rows } = await orDuplicate("A subject with this code already exists in this term", () =>
    pool.query(
      `INSERT INTO planner_subjects (term_id, code, name, kind, duration_min, weekly_count, semester_total, allow_second_lab)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${COLS}`,
      [termId, b.code, b.name, b.kind, duration, b.weekly_count, b.semester_total ?? null, b.allow_second_lab ?? false]
    )
  );
  return rows[0];
}

/** Number of placed sessions (any version) of a subject. */
async function countPlacedForSubject(db, subjectId) {
  const { rows: [{ n }] } = await db.query(
    `SELECT count(*)::int AS n FROM planner_sessions s JOIN planner_offerings o ON o.id = s.offering_id
      WHERE o.subject_id = $1 AND s.weekday IS NOT NULL`,
    [subjectId]
  );
  return n;
}

export async function updateSubject(termId, sid, body) {
  const patch = parse(patchSchema, body);
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!keys.length) failField("_", "No fields to update");
  for (const k of keys) if (patch[k] === null && k !== "semester_total") failField(k, "cannot be empty");
  await getSubject(termId, sid);
  if (patch.code) await assertCodeFree(termId, patch.code, sid);
  const sets = [];
  const vals = [sid];
  for (const k of keys) {
    vals.push(patch[k]);
    sets.push(`${k} = $${vals.length}`);
  }
  await orDuplicate("A subject with this code already exists in this term", () =>
    withTransaction(async (db) => {
      if (patch.duration_min !== undefined || patch.kind !== undefined) {
        // placed sessions have end_min = start_min + duration and a room row whose kind depends on the subject kind;
        // serialise against in-flight placements first, then judge on the row as it is now
        await lockTermVersions(db, termId);
        const { rows: [cur] } = await db.query("SELECT kind, duration_min FROM planner_subjects WHERE id = $1 AND term_id = $2", [sid, termId]);
        if (!cur) throw notFound("Subject not found");
        const fields = [];
        if (patch.duration_min !== undefined && patch.duration_min !== cur.duration_min) fields.push("duration_min");
        if (patch.kind !== undefined && patch.kind !== cur.kind) fields.push("kind");
        if (fields.length) {
          const placed = await countPlacedForSubject(db, sid);
          if (placed > 0) {
            const what = fields.length > 1 ? "kind and duration" : fields[0] === "kind" ? "kind (theory or lab)" : "duration";
            throw lockedByPlacements(
              `The ${what} cannot change while sessions of this subject are placed on the timetable. Unplace them first.`,
              { fields, placed }
            );
          }
        }
      }
      await db.query(`UPDATE planner_subjects SET ${sets.join(", ")} WHERE id = $1`, vals);
    })
  );
  return getSubject(termId, sid);
}

export async function deleteSubject(termId, sid) {
  await getSubject(termId, sid);
  const { rows: [{ n }] } = await pool.query("SELECT count(*)::int AS n FROM planner_offerings WHERE subject_id = $1", [sid]);
  if (n > 0) throw inUse("This subject has offerings. Delete those offerings first.", { offerings: n });
  await pool.query("DELETE FROM planner_subjects WHERE id = $1", [sid]);
}
