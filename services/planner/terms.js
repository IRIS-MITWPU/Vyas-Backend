import { z } from "zod";
import { pool, withTransaction } from "./tx.js";
import { parse, failField, text, int, dateStr } from "./validate.js";
import { notFound, orDuplicate, PlannerError } from "./errors.js";
import { lockTermVersions } from "./guards.js";
import { DEFAULT_TERM_SETTINGS, DEFAULT_RULES } from "./domain/index.js";

// Dates are returned as 'YYYY-MM-DD' strings (node-pg would turn DATE into a local-midnight Date).
export const TERM_COLS = `t.id, t.academic_year, t.half, t.branch,
  to_char(t.start_date, 'YYYY-MM-DD') AS start_date, to_char(t.end_date, 'YYYY-MM-DD') AS end_date,
  t.working_days, t.day_start_min, t.day_end_min, t.grid_minutes, t.theory_minutes, t.lab_minutes,
  t.breaks, t.created_by, t.created_at, t.updated_at`;

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
});
const patchSchema = z.object(termFields).partial();

/** Cross-field rules on a complete (merged) term. Throws 400 VALIDATION_ERROR. */
function checkTerm(t) {
  if (t.day_start_min >= t.day_end_min) failField("day_end_min", "must be later than day_start_min");
  if (t.start_date && t.end_date && t.start_date > t.end_date) failField("end_date", "must not be before start_date");
  for (const [i, b] of (t.breaks || []).entries()) {
    if (b.start_min >= b.end_min) failField(`breaks.${i}.end_min`, "must be later than start_min");
  }
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
  };
  checkTerm(term);

  return orDuplicate("A term for this academic year, half and branch already exists", () =>
    withTransaction(async (db) => {
      const { rows: [{ id }] } = await db.query(
        `INSERT INTO planner_terms (academic_year, half, branch, start_date, end_date, working_days,
           day_start_min, day_end_min, grid_minutes, theory_minutes, lab_minutes, breaks, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) RETURNING id`,
        [term.academic_year, term.half, term.branch, term.start_date, term.end_date, term.working_days,
          term.day_start_min, term.day_end_min, term.grid_minutes, term.theory_minutes, term.lab_minutes,
          JSON.stringify(term.breaks), userId ?? null]
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

export async function updateTerm(id, body) {
  const patch = parse(patchSchema, body);
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
      if (changedLocked.length) {
        // serialise against placements in flight: an editor op holds its version row lock until it commits,
        // so the count below can no longer miss a session that is being placed right now
        await lockTermVersions(db, id);
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

      const sets = [];
      const vals = [id];
      for (const k of keys) {
        vals.push(k === "working_days" ? merged.working_days : k === "breaks" ? JSON.stringify(patch.breaks) : patch[k]);
        sets.push(`${k} = $${vals.length}${k === "breaks" ? "::jsonb" : ""}`);
      }
      await db.query(`UPDATE planner_terms SET ${sets.join(", ")} WHERE id = $1`, vals);
      return getTermRow(db, id);
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
