import { z } from "zod";
import { pool } from "./tx.js";
import { parse, failField, text, optText, optIntIn, uuid } from "./validate.js";
import { LIMITS } from "./domain/limits.js";
import { notFound, inUse, orDuplicate } from "./errors.js";

const shortCode = text(LIMITS.short_code).refine((s) => !/[|,;:]/.test(s), "cannot contain | , ; or :");
const email = z.preprocess(
  (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim().toLowerCase()) : v),
  z.string().email("must be a valid email address").max(LIMITS.email).nullable().optional()
);

const createSchema = z.object({
  short_code: shortCode,
  full_name: text(LIMITS.full_name),
  email,
  department: optText(LIMITS.department),
  max_per_day: optIntIn(LIMITS.max_per_day),
  max_per_week: optIntIn(LIMITS.max_per_week),
  is_active: z.boolean().optional(),
});
const patchSchema = z.object({
  short_code: shortCode,
  full_name: text(LIMITS.full_name),
  email,
  department: optText(LIMITS.department),
  max_per_day: optIntIn(LIMITS.max_per_day),
  max_per_week: optIntIn(LIMITS.max_per_week),
  is_active: z.boolean(),
}).partial();

const listQuery = z.object({ term_id: uuid.optional() });

// Profile whose email matches, unless another faculty row already holds that profile
// (planner_faculty.profile_id is UNIQUE). $N = email, exceptId = faculty row being edited (or null).
const linkSql = (emailParam, exceptParam) =>
  `(SELECT p.id FROM profiles p WHERE p.email = ${emailParam}
      AND NOT EXISTS (SELECT 1 FROM planner_faculty x WHERE x.profile_id = p.id AND x.id IS DISTINCT FROM ${exceptParam}))`;

const FACULTY_SELECT = (assignedSql) => `
  SELECT f.id, f.profile_id, f.short_code, f.full_name, f.email, f.department, f.max_per_day, f.max_per_week,
         f.is_active, f.created_at, f.updated_at,
         CASE WHEN p.id IS NULL THEN NULL
              ELSE jsonb_build_object('id', p.id, 'full_name', p.full_name, 'email', p.email) END AS linked_profile,
         ${assignedSql} AS assigned_in_term
    FROM planner_faculty f LEFT JOIN profiles p ON p.id = f.profile_id`;

export async function listFaculty(query) {
  const { term_id } = parse(listQuery, query);
  const assigned = term_id
    ? `(SELECT count(*)::int FROM planner_offering_faculty ofa
          JOIN planner_offerings o ON o.id = ofa.offering_id
          JOIN planner_divisions d ON d.id = o.division_id
         WHERE d.term_id = $1 AND ofa.faculty_id = f.id)`
    : "NULL::int";
  const { rows } = await pool.query(`${FACULTY_SELECT(assigned)} ORDER BY lower(f.short_code)`, term_id ? [term_id] : []);
  return rows;
}

async function getFaculty(db, id) {
  const { rows } = await db.query(`${FACULTY_SELECT("NULL::int")} WHERE f.id = $1`, [id]);
  if (!rows[0]) throw notFound("Faculty not found");
  return rows[0];
}

export async function createFaculty(body) {
  const b = parse(createSchema, body);
  const em = b.email ?? null;
  const id = await orDuplicate("A faculty member with this short code already exists", async () => {
    const { rows } = await pool.query(
      `INSERT INTO planner_faculty (profile_id, short_code, full_name, email, department, max_per_day, max_per_week, is_active)
       VALUES (${linkSql("$4", "NULL")}, $1, $2, $4, $3, $5, $6, $7) RETURNING id`,
      [b.short_code, b.full_name, b.department ?? null, em, b.max_per_day ?? null, b.max_per_week ?? null, b.is_active ?? true]
    );
    return rows[0].id;
  });
  return getFaculty(pool, id);
}

export async function updateFaculty(id, body) {
  const patch = parse(patchSchema, body);
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!keys.length) failField("_", "No fields to update");
  for (const k of ["short_code", "full_name", "is_active"]) if (patch[k] === null) failField(k, "cannot be empty");
  await getFaculty(pool, id);

  const sets = [];
  const vals = [id];
  for (const k of keys) {
    vals.push(patch[k]);
    sets.push(`${k} = $${vals.length}`);
  }
  if ("email" in patch) {
    // Re-link by the new email; clearing the email unlinks.
    sets.push(`profile_id = ${linkSql(`$${keys.indexOf("email") + 2}`, "$1")}`);
  }
  await orDuplicate("A faculty member with this short code already exists", () =>
    pool.query(`UPDATE planner_faculty SET ${sets.join(", ")} WHERE id = $1`, vals)
  );
  return getFaculty(pool, id);
}

export async function deleteFaculty(id) {
  await getFaculty(pool, id);
  const { rows: [{ offerings, sessions }] } = await pool.query(
    `SELECT (SELECT count(*)::int FROM planner_offering_faculty WHERE faculty_id = $1) AS offerings,
            (SELECT count(*)::int FROM planner_session_faculty WHERE faculty_id = $1) AS sessions`,
    [id]
  );
  const inUseMessage = "This faculty member is assigned to offerings or generated sessions. Remove those assignments first.";
  if (offerings > 0 || sessions > 0) throw inUse(inUseMessage, { offerings, sessions });
  try {
    await pool.query("DELETE FROM planner_faculty WHERE id = $1", [id]);
  } catch (err) {
    if (err?.code === "23503") throw inUse(inUseMessage);
    throw err;
  }
}
