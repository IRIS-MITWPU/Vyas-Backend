import { z } from "zod";
import { pool, withTransaction } from "./tx.js";
import { parse, failField } from "./validate.js";
import { PlannerError } from "./errors.js";
import { divisionsWithPlacedWholeSessions } from "./divisions.js";
import { lockTermVersions } from "./guards.js";
import { requireTerm } from "./terms.js";
import { IMPORT_ENTITIES, IMPORT_TEMPLATES, validateImportRows, groupImportRows } from "./domain/index.js";

const MAX_ROWS = 2000;
const bodySchema = z.object({ rows: z.array(z.any()).max(MAX_ROWS, `at most ${MAX_ROWS} rows per import`) });

const lc = (s) => String(s ?? "").trim().toLowerCase();
const collapse = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

export const importTemplates = () => IMPORT_TEMPLATES;

export function parseEntity(entity) {
  if (!IMPORT_ENTITIES.includes(entity)) failField("entity", `entity must be one of ${IMPORT_ENTITIES.join(", ")}`);
  return entity;
}

/** dryRun must be exactly "true" or "false" when present: a typo must not turn into a real import. */
export function parseDryRun(value) {
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  return failField("dryRun", "dryRun must be true or false");
}

/** Builds the validation ctx (see domain/importSpec.js) from the database. */
async function buildCtx(db, term) {
  const ctx = { term, faculty: {}, subjects: {}, divisions: {}, rooms: {}, offerings: {} };
  for (const f of (await db.query("SELECT id, short_code FROM planner_faculty")).rows) ctx.faculty[lc(f.short_code)] = { id: f.id };
  for (const s of (await db.query("SELECT id, code, kind FROM planner_subjects WHERE term_id = $1", [term.id])).rows) {
    ctx.subjects[lc(s.code)] = { id: s.id, kind: s.kind };
  }
  const { rows: divs } = await db.query("SELECT id, semester, name FROM planner_divisions WHERE term_id = $1", [term.id]);
  const byId = new Map();
  for (const d of divs) {
    const entry = { id: d.id, batches: [] };
    byId.set(d.id, entry);
    ctx.divisions[`${d.semester}|${lc(d.name)}`] = entry;
  }
  if (divs.length) {
    const { rows: batches } = await db.query(
      "SELECT division_id, name FROM planner_batches WHERE division_id = ANY($1::uuid[]) AND NOT is_whole",
      [divs.map((d) => d.id)]
    );
    for (const b of batches) byId.get(b.division_id).batches.push(b.name);
  }
  // a term with a building only resolves the rooms of that building (contract 10.2)
  const rooms = await db.query(
    `SELECT r.id, r.name, b.name AS building FROM rooms r JOIN floors f ON f.id = r.floor_id JOIN buildings b ON b.id = f.building_id
      WHERE ($1::uuid IS NULL OR f.building_id = $1::uuid)`,
    [term.building_id ?? null]
  );
  for (const r of rooms.rows) {
    const k = `${collapse(r.building)} / ${collapse(r.name)}`;
    ctx.rooms[k] = ctx.rooms[k] ? [...[].concat(ctx.rooms[k]), { id: r.id }] : { id: r.id };
  }
  const offs = await db.query(
    `SELECT o.id, d.semester, d.name AS division, s.code
       FROM planner_offerings o JOIN planner_divisions d ON d.id = o.division_id JOIN planner_subjects s ON s.id = o.subject_id
      WHERE d.term_id = $1`,
    [term.id]
  );
  for (const o of offs.rows) ctx.offerings[`${o.semester}|${lc(o.division)}|${lc(o.code)}`] = { id: o.id };
  return ctx;
}

/**
 * A new batch under a division whose whole-division sessions are placed would leave those sessions without an
 * occupancy row for the batch, so such rows become row errors (existing batches may still be updated).
 * Mutates the validation results of a "divisions" import.
 */
async function guardPlacedDivisions(db, results, ctx) {
  const ids = [...new Set(Object.values(ctx.divisions).map((d) => d.id))];
  const placed = await divisionsWithPlacedWholeSessions(db, ids);
  if (!placed.size) return;
  for (const r of results) {
    const n = r.normalized;
    if (r.status === "error" || !n?.batch) continue;
    const d = ctx.divisions[`${n.semester}|${lc(n.name)}`];
    if (!d || !placed.has(d.id)) continue;
    if ((d.batches ?? []).some((b) => lc(b) === lc(n.batch.name))) continue;
    r.status = "error";
    r.errors = [...(r.errors ?? []), {
      field: "batch",
      message: `Division ${n.name} has whole-division sessions placed on the timetable, so batch "${n.batch.name}" cannot be added. Unplace them first.`,
    }];
  }
}

/**
 * Changing the duration or the kind of a subject whose sessions are placed would break their end times / room
 * rows, so such rows become row errors (dry run and real run alike). Mutates the validation results of a
 * "subjects" import.
 */
async function guardPlacedSubjects(db, results, ctx, termId) {
  const candidates = results.filter((r) => r.status !== "error" && r.normalized && ctx.subjects[lc(r.normalized.code)]);
  if (!candidates.length) return;
  const { rows } = await db.query(
    `SELECT s.id, s.duration_min, s.kind,
            EXISTS (SELECT 1 FROM planner_sessions ps JOIN planner_offerings o ON o.id = ps.offering_id
                     WHERE o.subject_id = s.id AND ps.weekday IS NOT NULL) AS placed
       FROM planner_subjects s WHERE s.term_id = $1`,
    [termId]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of candidates) {
    const n = r.normalized;
    const cur = byId.get(ctx.subjects[lc(n.code)].id);
    if (!cur || !cur.placed) continue;
    const errors = [];
    if (n.duration_min != null && cur.duration_min !== n.duration_min) {
      errors.push({ field: "duration_min", message: `Subject ${n.code} has sessions placed on the timetable, so its duration cannot change. Unplace them first.` });
    }
    if (n.kind != null && cur.kind !== n.kind) {
      errors.push({ field: "kind", message: `Subject ${n.code} has sessions placed on the timetable, so its kind (theory or lab) cannot change. Unplace them first.` });
    }
    if (!errors.length) continue;
    r.status = "error";
    r.errors = [...(r.errors ?? []), ...errors];
  }
}

/**
 * Changing the student count of a division or batch whose placed lab sessions sit in a shared lab room could
 * over-fill that room silently, so such rows become row errors. Mutates the validation results of a "divisions"
 * import. A blank batch_size (null) keeps the stored size and is not a change.
 */
async function guardSharedLabStudentCounts(db, results, ctx, termId) {
  const { rows: shared } = await db.query(
    `SELECT DISTINCT b.division_id, s.batch_id, b.is_whole
       FROM planner_sessions s
       JOIN planner_occupancy o ON o.session_id = s.id AND o.kind = 'lab_room'
       JOIN planner_batches b ON b.id = s.batch_id
       JOIN planner_divisions d ON d.id = b.division_id
      WHERE d.term_id = $1 AND s.weekday IS NOT NULL`,
    [termId]
  );
  if (!shared.length) return;
  const sharedDivisions = new Set(shared.map((r) => r.division_id)); // any batch of it
  const wholeShared = new Set(shared.filter((r) => r.is_whole).map((r) => r.division_id)); // uses the division's count
  const sharedBatches = new Set(shared.map((r) => r.batch_id));
  const { rows: divs } = await db.query("SELECT id, student_count FROM planner_divisions WHERE term_id = $1", [termId]);
  const divCount = new Map(divs.map((d) => [d.id, d.student_count]));
  const { rows: bats } = await db.query(
    "SELECT b.id, b.division_id, b.name, b.student_count FROM planner_batches b WHERE b.division_id = ANY($1::uuid[]) AND NOT b.is_whole",
    [[...sharedDivisions]]
  );
  for (const r of results) {
    const n = r.normalized;
    if (r.status === "error" || !n) continue;
    const d = ctx.divisions[`${n.semester}|${lc(n.name)}`];
    if (!d || !sharedDivisions.has(d.id)) continue;
    const errors = [];
    if (wholeShared.has(d.id) && divCount.get(d.id) !== n.student_count) {
      errors.push({
        field: "student_count",
        message: `Division ${n.name} has lab sessions placed in a shared lab room, so its student count cannot change. Unplace them first.`,
      });
    }
    if (n.batch && n.batch.student_count != null) {
      const hit = bats.find((b) => b.division_id === d.id && lc(b.name) === lc(n.batch.name));
      if (hit && sharedBatches.has(hit.id) && hit.student_count !== n.batch.student_count) {
        errors.push({
          field: "batch_size",
          message: `Batch "${n.batch.name}" of division ${n.name} has lab sessions placed in a shared lab room, so its size cannot change. Unplace them first.`,
        });
      }
    }
    if (!errors.length) continue;
    r.status = "error";
    r.errors = [...(r.errors ?? []), ...errors];
  }
}

function summarize(results) {
  const summary = { total: results.length, create: 0, update: 0, error: 0 };
  for (const r of results) summary[r.status] += 1;
  return summary;
}
const publicRows = (results) => results.map(({ row, status, errors, warnings, key }) => ({ row, status, errors, warnings, key }));

// ------------------------------------------------------------ apply (one transaction)

async function applyFaculty(db, results) {
  for (const r of groupImportRows("faculty", results)) {
    await db.query(
      `INSERT INTO planner_faculty (profile_id, short_code, full_name, email, department, max_per_day, max_per_week)
       VALUES ((SELECT p.id FROM profiles p WHERE p.email = $4
                  AND NOT EXISTS (SELECT 1 FROM planner_faculty x WHERE x.profile_id = p.id)),
               $1, $2, $4, $3, $5, $6)
       ON CONFLICT ((lower(short_code))) DO UPDATE SET
         full_name    = EXCLUDED.full_name,
         email        = COALESCE(EXCLUDED.email, planner_faculty.email),
         department   = COALESCE(EXCLUDED.department, planner_faculty.department),
         max_per_day  = COALESCE(EXCLUDED.max_per_day, planner_faculty.max_per_day),
         max_per_week = COALESCE(EXCLUDED.max_per_week, planner_faculty.max_per_week),
         -- blank email keeps the stored email and its link; a given email re-links by it and unlinks when it matches no profile
         profile_id   = CASE WHEN EXCLUDED.email IS NULL THEN planner_faculty.profile_id
                             ELSE (SELECT p.id FROM profiles p WHERE p.email = EXCLUDED.email
                                     AND NOT EXISTS (SELECT 1 FROM planner_faculty x WHERE x.profile_id = p.id AND x.id <> planner_faculty.id))
                        END`,
      [r.short_code, r.full_name, r.department, r.email, r.max_per_day, r.max_per_week]
    );
  }
}

async function applySubjects(db, results, ctx, termId) {
  for (const r of groupImportRows("subjects", results)) {
    const existing = ctx.subjects[lc(r.code)];
    if (existing) {
      await db.query(
        // blank duration_min / allow_second_lab arrive as null and keep the stored value
        `UPDATE planner_subjects SET name = $2, kind = $3, duration_min = COALESCE($4, duration_min), weekly_count = $5,
                semester_total = COALESCE($6, semester_total), allow_second_lab = COALESCE($7, allow_second_lab) WHERE id = $1`,
        [existing.id, r.name, r.kind, r.duration_min, r.weekly_count, r.semester_total, r.allow_second_lab]
      );
    } else {
      await db.query(
        `INSERT INTO planner_subjects (term_id, code, name, kind, duration_min, weekly_count, semester_total, allow_second_lab)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [termId, r.code, r.name, r.kind, r.duration_min, r.weekly_count, r.semester_total, r.allow_second_lab]
      );
    }
  }
}

async function applyDivisions(db, results, ctx, termId) {
  for (const g of groupImportRows("divisions", results)) {
    let id = ctx.divisions[`${g.semester}|${lc(g.name)}`]?.id;
    if (id) {
      await db.query(
        "UPDATE planner_divisions SET student_count = $2, home_room_id = COALESCE($3, home_room_id), home_room2_id = CASE WHEN home_room2_id = COALESCE($3, home_room_id) THEN NULL ELSE home_room2_id END WHERE id = $1",
        [id, g.student_count, g.home_room_id]
      );
      await db.query("UPDATE planner_batches SET student_count = $2 WHERE division_id = $1 AND is_whole", [id, g.student_count]);
    } else {
      ({ rows: [{ id }] } = await db.query(
        "INSERT INTO planner_divisions (term_id, semester, name, student_count, home_room_id) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [termId, g.semester, g.name, g.student_count, g.home_room_id]
      ));
      await db.query("INSERT INTO planner_batches (division_id, name, student_count, is_whole) VALUES ($1, 'ALL', $2, true)", [id, g.student_count]);
    }
    for (const b of g.batches) {
      const { rows: [hit] } = await db.query("SELECT id FROM planner_batches WHERE division_id = $1 AND lower(name) = lower($2)", [id, b.name]);
      // a blank batch_size (null) keeps the stored size of an existing batch; a new batch starts at 0
      if (hit) await db.query("UPDATE planner_batches SET student_count = COALESCE($2, student_count) WHERE id = $1", [hit.id, b.student_count]);
      else await db.query("INSERT INTO planner_batches (division_id, name, student_count) VALUES ($1,$2,$3)", [id, b.name, b.student_count ?? 0]);
    }
  }
}

async function applyOfferings(db, results, ctx) {
  const kindById = new Map(Object.values(ctx.subjects).map((s) => [s.id, s.kind]));
  const batchCache = new Map(); // division id -> Map(lowercased batch name -> id)
  const batchesOf = async (divisionId) => {
    if (!batchCache.has(divisionId)) {
      const { rows } = await db.query("SELECT id, name FROM planner_batches WHERE division_id = $1 AND NOT is_whole", [divisionId]);
      batchCache.set(divisionId, new Map(rows.map((b) => [lc(b.name), b.id])));
    }
    return batchCache.get(divisionId);
  };
  for (const g of groupImportRows("offerings", results)) {
    let id = ctx.offerings[`${g.semester}|${lc(g.division)}|${lc(g.subject_code)}`]?.id;
    if (id) {
      if (g.weekly_count !== null) await db.query("UPDATE planner_offerings SET weekly_count = $2 WHERE id = $1", [id, g.weekly_count]);
    } else {
      ({ rows: [{ id }] } = await db.query(
        "INSERT INTO planner_offerings (division_id, subject_id, weekly_count, per_batch) VALUES ($1,$2,$3,$4) RETURNING id",
        [g.division_id, g.subject_id, g.weekly_count, kindById.get(g.subject_id) === "lab"]
      ));
    }
    for (const f of g.faculty) {
      let batchId = null;
      if (f.batch) {
        batchId = (await batchesOf(g.division_id)).get(lc(f.batch)) ?? null;
        if (!batchId) throw new PlannerError(409, "IMPORT_CONFLICT", `Batch "${f.batch}" disappeared during the import; try again`);
      }
      await db.query(
        `INSERT INTO planner_offering_faculty (offering_id, batch_id, faculty_id, role) VALUES ($1,$2,$3,$4)
         ON CONFLICT (offering_id, (COALESCE(batch_id, '00000000-0000-0000-0000-000000000000'::uuid)), faculty_id)
         DO UPDATE SET role = EXCLUDED.role`,
        [id, batchId, f.faculty_id, f.role]
      );
    }
  }
}

/**
 * Validates and (unless dryRun) applies an import. A real run is one transaction that holds the term row
 * lock, re-validates against the data as it is inside the transaction, and applies nothing at all when any
 * row is an error (422 IMPORT_HAS_ERRORS).
 */
export async function runImport(termId, entity, body, { dryRun }) {
  const { rows } = parse(bodySchema, body);

  if (dryRun) {
    const term = await requireTerm(pool, termId);
    const ctx = await buildCtx(pool, term);
    const results = validateImportRows(entity, rows, ctx);
    if (entity === "divisions") {
      await guardPlacedDivisions(pool, results, ctx);
      await guardSharedLabStudentCounts(pool, results, ctx, termId);
    }
    if (entity === "subjects") await guardPlacedSubjects(pool, results, ctx, termId);
    return { dry_run: true, applied: false, summary: summarize(results), rows: publicRows(results) };
  }

  return withTransaction(async (db) => {
    const term = await requireTerm(db, termId, { lock: true });
    // structural changes wait for any placement in flight (editor ops hold their version row lock)
    if (entity === "divisions" || entity === "subjects") await lockTermVersions(db, termId);
    const ctx = await buildCtx(db, term);
    const results = validateImportRows(entity, rows, ctx);
    if (entity === "divisions") {
      await guardPlacedDivisions(db, results, ctx);
      await guardSharedLabStudentCounts(db, results, ctx, termId);
    }
    if (entity === "subjects") await guardPlacedSubjects(db, results, ctx, termId);
    const summary = summarize(results);
    if (summary.error > 0) {
      throw new PlannerError(422, "IMPORT_HAS_ERRORS", "Import has errors", { summary, rows: publicRows(results), nothing_applied: true });
    }
    if (entity === "faculty") await applyFaculty(db, results);
    else if (entity === "subjects") await applySubjects(db, results, ctx, termId);
    else if (entity === "divisions") await applyDivisions(db, results, ctx, termId);
    else await applyOfferings(db, results, ctx);
    return { dry_run: false, applied: true, summary, rows: publicRows(results) };
  });
}
