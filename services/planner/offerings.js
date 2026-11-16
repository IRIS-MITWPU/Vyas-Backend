import { z } from "zod";
import { pool, withTransaction } from "./tx.js";
import { parse, failField, intIn, optIntIn, uuid } from "./validate.js";
import { LIMITS } from "./domain/limits.js";
import { notFound, orDuplicate } from "./errors.js";
import { requireTerm } from "./terms.js";
import { removeUnplacedSessions } from "./guards.js";

const facultyEntry = z.object({
  batch_id: uuid.nullable().optional(),
  faculty_id: uuid,
  role: z.enum(["lead", "assist"], { error: "must be lead or assist" }).optional(),
});
const facultyList = z.array(facultyEntry).max(LIMITS.faculty_per_offering);

const createSchema = z.object({
  division_id: uuid,
  subject_id: uuid,
  weekly_count: optIntIn(LIMITS.weekly_count),
  per_batch: z.boolean().optional(),
  faculty: facultyList.optional(),
});
const patchSchema = z.object({ weekly_count: intIn(LIMITS.weekly_count).nullable(), per_batch: z.boolean() }).partial();
const putSchema = z.object({ faculty: facultyList });
const listQuery = z.object({ division_id: uuid.optional() });

/** Offerings of a term with subject and faculty, ordered by semester, division, subject code. */
export async function loadOfferings(db, termId, { divisionId = null, offeringId = null } = {}) {
  const { rows: offerings } = await db.query(
    `SELECT o.id, o.division_id, o.subject_id, o.weekly_count, o.per_batch,
            COALESCE(o.weekly_count, s.weekly_count) AS effective_weekly_count,
            jsonb_build_object('code', s.code, 'name', s.name, 'kind', s.kind) AS subject
       FROM planner_offerings o
       JOIN planner_divisions d ON d.id = o.division_id
       JOIN planner_subjects s ON s.id = o.subject_id
      WHERE d.term_id = $1 AND ($2::uuid IS NULL OR o.division_id = $2) AND ($3::uuid IS NULL OR o.id = $3)
      ORDER BY d.semester, lower(d.name), d.name, lower(s.code), s.code`,
    [termId, divisionId, offeringId]
  );
  if (!offerings.length) return [];
  const { rows: fac } = await db.query(
    `SELECT ofa.id, ofa.offering_id, ofa.batch_id, ofa.faculty_id, ofa.role, f.short_code, f.full_name
       FROM planner_offering_faculty ofa JOIN planner_faculty f ON f.id = ofa.faculty_id
      WHERE ofa.offering_id = ANY($1::uuid[])
      ORDER BY lower(f.short_code), ofa.id`,
    [offerings.map((o) => o.id)]
  );
  for (const o of offerings) {
    o.faculty = fac.filter((f) => f.offering_id === o.id).map(({ offering_id, ...rest }) => rest);
  }
  return offerings;
}

export async function listOfferings(termId, query) {
  const { division_id } = parse(listQuery, query);
  await requireTerm(pool, termId);
  return loadOfferings(pool, termId, { divisionId: division_id ?? null });
}

async function getOffering(db, termId, oid) {
  const [o] = await loadOfferings(db, termId, { offeringId: oid });
  if (!o) throw notFound("Offering not found");
  return o;
}

/** Replaces the faculty set of an offering. Validates faculty exist and batches belong to the offering's division. */
async function setOfferingFaculty(db, offeringId, divisionId, entries) {
  const seen = new Set();
  entries.forEach((e, i) => {
    const k = `${e.batch_id ?? ""}|${e.faculty_id}`;
    if (seen.has(k)) failField(`faculty.${i}.faculty_id`, "this faculty member is listed twice for the same batch");
    seen.add(k);
  });
  if (entries.length) {
    const facultyIds = [...new Set(entries.map((e) => e.faculty_id))];
    const { rows } = await db.query("SELECT id FROM planner_faculty WHERE id = ANY($1::uuid[])", [facultyIds]);
    const known = new Set(rows.map((r) => r.id));
    entries.forEach((e, i) => {
      if (!known.has(e.faculty_id)) failField(`faculty.${i}.faculty_id`, "faculty member not found");
    });
    const batchIds = [...new Set(entries.map((e) => e.batch_id).filter(Boolean))];
    if (batchIds.length) {
      const { rows: bs } = await db.query("SELECT id FROM planner_batches WHERE division_id = $1 AND id = ANY($2::uuid[])", [divisionId, batchIds]);
      const ok = new Set(bs.map((r) => r.id));
      entries.forEach((e, i) => {
        if (e.batch_id && !ok.has(e.batch_id)) failField(`faculty.${i}.batch_id`, "batch does not belong to this offering's division");
      });
    }
  }
  await db.query("DELETE FROM planner_offering_faculty WHERE offering_id = $1", [offeringId]);
  for (const e of entries) {
    await db.query(
      "INSERT INTO planner_offering_faculty (offering_id, batch_id, faculty_id, role) VALUES ($1,$2,$3,$4)",
      [offeringId, e.batch_id ?? null, e.faculty_id, e.role ?? "lead"]
    );
  }
}

export async function createOffering(termId, body) {
  await requireTerm(pool, termId);
  const b = parse(createSchema, body);
  return orDuplicate("This division already has an offering for that subject", () =>
    withTransaction(async (db) => {
      const { rows: [division] } = await db.query("SELECT id FROM planner_divisions WHERE id = $1 AND term_id = $2", [b.division_id, termId]);
      if (!division) failField("division_id", "division not found in this term");
      const { rows: [subject] } = await db.query("SELECT id, kind FROM planner_subjects WHERE id = $1 AND term_id = $2", [b.subject_id, termId]);
      if (!subject) failField("subject_id", "subject not found in this term");
      const { rows: [{ id }] } = await db.query(
        `INSERT INTO planner_offerings (division_id, subject_id, weekly_count, per_batch) VALUES ($1,$2,$3,$4) RETURNING id`,
        [b.division_id, b.subject_id, b.weekly_count ?? null, b.per_batch ?? subject.kind === "lab"]
      );
      await setOfferingFaculty(db, id, b.division_id, b.faculty ?? []);
      return getOffering(db, termId, id);
    })
  );
}

export async function updateOffering(termId, oid, body) {
  const patch = parse(patchSchema, body);
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!keys.length) failField("_", "No fields to update");
  if (patch.per_batch === null) failField("per_batch", "cannot be empty");
  await getOffering(pool, termId, oid);
  const sets = [];
  const vals = [oid];
  for (const k of keys) {
    vals.push(patch[k]);
    sets.push(`${k} = $${vals.length}`);
  }
  await pool.query(`UPDATE planner_offerings SET ${sets.join(", ")} WHERE id = $1`, vals);
  return getOffering(pool, termId, oid);
}

export async function putOfferingFaculty(termId, oid, body) {
  const b = parse(putSchema, body);
  return withTransaction(async (db) => {
    const o = await getOffering(db, termId, oid);
    await setOfferingFaculty(db, oid, o.division_id, b.faculty);
    return getOffering(db, termId, oid);
  });
}

/** Returns the draft versions whose rev was bumped ([{version_id, prev_rev, rev}]) so the route can emit planner:changed. */
export async function deleteOffering(termId, oid) {
  return withTransaction(async (db) => {
    const o = await getOffering(db, termId, oid);
    const bumps = await removeUnplacedSessions(db, termId, "offering", oid, `Offering ${o.subject.code}`);
    await db.query("DELETE FROM planner_offerings WHERE id = $1", [oid]);
    return bumps;
  });
}
