import { z } from "zod";
import { pool, withTransaction } from "./tx.js";
import { parse, uuid } from "./validate.js";
import { notFound, PlannerError } from "./errors.js";
import { expectedSessions, planSessionSync } from "./domain/index.js";
import { loadSubjects } from "./state.js";
import { loadDivisions } from "./divisions.js";
import { loadOfferings } from "./offerings.js";

const listQuery = z.object({ division_id: uuid.optional() });

export async function getVersion(db, versionId, { lock = false } = {}) {
  const { rows } = await db.query(
    `SELECT id, term_id, version_no, status, rev FROM planner_versions WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [versionId]
  );
  if (!rows[0]) throw notFound("Version not found");
  return rows[0];
}

/** Domain state needed to expand offerings into sessions. */
async function loadSyncState(db, termId) {
  const subjects = await loadSubjects(db, termId);
  const divisions = await loadDivisions(db, termId);
  const offerings = await loadOfferings(db, termId);
  return { subjects, divisions, offerings };
}

const countBy = (items, keyFn) => {
  const m = new Map();
  for (const i of items) m.set(keyFn(i), (m.get(keyFn(i)) ?? 0) + 1);
  return m;
};

/**
 * Brings the draft's sessions in line with the term's offerings. One transaction, version row locked.
 * Adds missing unplaced sessions (with their faculty), removes surplus unplaced ones (highest seq first),
 * never deletes a placed session (reported in placed_surplus), refreshes the faculty of existing UNPLACED
 * sessions from the offering's faculty (placed sessions keep theirs), and bumps rev only when something changed.
 */
export async function syncSessions(versionId) {
  return withTransaction(async (db) => {
    const version = await getVersion(db, versionId, { lock: true });
    if (version.status !== "draft") {
      throw new PlannerError(409, "VALIDATION_ERROR", "Only a draft version can be synced", { fieldErrors: { status: ["version is not a draft"] } });
    }
    const state = await loadSyncState(db, version.term_id);
    const expected = expectedSessions(state);

    const { rows: existing } = await db.query(
      "SELECT id, offering_id, batch_id, seq, (weekday IS NOT NULL) AS placed FROM planner_sessions WHERE version_id = $1",
      [versionId]
    );
    const plan = planSessionSync({ expected, existing });

    let removed = 0;
    if (plan.toDeleteIds.length) {
      // weekday IS NULL is a second guard: a placed session is never deleted here
      const res = await db.query("DELETE FROM planner_sessions WHERE id = ANY($1::uuid[]) AND weekday IS NULL", [plan.toDeleteIds]);
      removed = res.rowCount;
    }

    let added = 0;
    if (plan.toCreate.length) {
      const { rows: created } = await db.query(
        `INSERT INTO planner_sessions (version_id, offering_id, batch_id, seq)
         SELECT $1, o, b, s FROM unnest($2::uuid[], $3::uuid[], $4::int[]) AS t(o, b, s)
         RETURNING id, offering_id, batch_id, seq`,
        [versionId, plan.toCreate.map((c) => c.offering_id), plan.toCreate.map((c) => c.batch_id), plan.toCreate.map((c) => c.seq)]
      );
      added = created.length;
      const facultyByKey = new Map(plan.toCreate.map((c) => [`${c.offering_id}|${c.batch_id}|${c.seq}`, c.faculty_ids]));
      const sIds = [];
      const fIds = [];
      for (const s of created) {
        for (const f of facultyByKey.get(`${s.offering_id}|${s.batch_id}|${s.seq}`) ?? []) {
          sIds.push(s.id);
          fIds.push(f);
        }
      }
      if (sIds.length) {
        await db.query(
          "INSERT INTO planner_session_faculty (session_id, faculty_id) SELECT s, f FROM unnest($1::uuid[], $2::uuid[]) AS t(s, f)",
          [sIds, fIds]
        );
      }
    }

    // Refresh faculty of UNPLACED sessions that already existed (the offering's faculty may have changed
    // since). Placed sessions are never touched: the editor owns them, and rev must not move for them.
    const deleted = new Set(plan.toDeleteIds);
    const kept = existing.filter((s) => !deleted.has(s.id));
    const refreshable = kept.filter((s) => !s.placed);
    const wanted = new Map();
    for (const e of expected) wanted.set(`${e.offering_id}|${e.batch_id}`, e.faculty_ids);
    let facultyUpdated = 0;
    if (refreshable.length) {
      const { rows: sf } = await db.query(
        "SELECT session_id, faculty_id FROM planner_session_faculty WHERE session_id = ANY($1::uuid[])",
        [refreshable.map((s) => s.id)]
      );
      const have = new Map();
      for (const r of sf) (have.get(r.session_id) ?? have.set(r.session_id, new Set()).get(r.session_id)).add(r.faculty_id);
      const addS = [], addF = [], delS = [], delF = [];
      const touched = new Set();
      for (const s of refreshable) {
        const want = wanted.get(`${s.offering_id}|${s.batch_id}`);
        if (!want) continue; // placed surplus whose group no longer expects anything: leave as is
        const cur = have.get(s.id) ?? new Set();
        for (const f of want) if (!cur.has(f)) { addS.push(s.id); addF.push(f); touched.add(s.id); }
        for (const f of cur) if (!want.includes(f)) { delS.push(s.id); delF.push(f); touched.add(s.id); }
      }
      if (delS.length) {
        await db.query(
          "DELETE FROM planner_session_faculty WHERE (session_id, faculty_id) IN (SELECT s, f FROM unnest($1::uuid[], $2::uuid[]) AS t(s, f))",
          [delS, delF]
        );
      }
      if (addS.length) {
        await db.query(
          "INSERT INTO planner_session_faculty (session_id, faculty_id) SELECT s, f FROM unnest($1::uuid[], $2::uuid[]) AS t(s, f)",
          [addS, addF]
        );
      }
      facultyUpdated = touched.size;
    }

    const prevRev = Number(version.rev);
    let rev = prevRev;
    if (added || removed || facultyUpdated) {
      const { rows: [{ rev: newRev }] } = await db.query("UPDATE planner_versions SET rev = rev + 1 WHERE id = $1 RETURNING rev", [versionId]);
      rev = Number(newRev);
    }

    // per-division summary after the sync
    const offeringDivision = new Map(state.offerings.map((o) => [o.id, o.division_id]));
    const required = new Map();
    for (const e of expected) required.set(offeringDivision.get(e.offering_id), (required.get(offeringDivision.get(e.offering_id)) ?? 0) + 1);
    const afterCounts = new Map();
    for (const s of [...kept, ...plan.toCreate]) {
      const d = offeringDivision.get(s.offering_id);
      afterCounts.set(d, (afterCounts.get(d) ?? 0) + 1);
    }
    const by_division = state.divisions.map((d) => ({
      division_id: d.id,
      semester: d.semester,
      name: d.name,
      required: required.get(d.id) ?? 0,
      existing: afterCounts.get(d.id) ?? 0,
    }));

    return {
      term_id: version.term_id,
      added,
      removed,
      kept: plan.kept,
      placed_surplus: plan.placedSurplus,
      by_division,
      faculty_updated: facultyUpdated,
      rev,
      prev_rev: prevRev,
    };
  });
}

export async function sessionsSummary(versionId) {
  const version = await getVersion(pool, versionId);
  const state = await loadSyncState(pool, version.term_id);
  const expected = expectedSessions(state);
  const { rows: existing } = await pool.query(
    `SELECT o.division_id, (s.weekday IS NOT NULL) AS placed
       FROM planner_sessions s JOIN planner_offerings o ON o.id = s.offering_id
      WHERE s.version_id = $1`,
    [versionId]
  );
  const offeringDivision = new Map(state.offerings.map((o) => [o.id, o.division_id]));
  const required = countBy(expected, (e) => offeringDivision.get(e.offering_id));
  const placed = countBy(existing.filter((s) => s.placed), (s) => s.division_id);
  const unplaced = countBy(existing.filter((s) => !s.placed), (s) => s.division_id);
  const { rows: [{ rev }] } = await pool.query("SELECT rev FROM planner_versions WHERE id = $1", [versionId]);
  return {
    rev: Number(rev),
    divisions: state.divisions.map((d) => ({
      division_id: d.id,
      semester: d.semester,
      name: d.name,
      required: required.get(d.id) ?? 0,
      placed: placed.get(d.id) ?? 0,
      unplaced: unplaced.get(d.id) ?? 0,
    })),
  };
}

const SESSION_SELECT = `
  SELECT s.id, s.offering_id, s.batch_id, s.seq, s.weekday, s.start_min, s.end_min, s.room_id, s.locked,
         sub.code AS subject_code, sub.name AS subject_name, sub.kind, sub.duration_min, b.name AS batch_name,
         COALESCE(jsonb_agg(jsonb_build_object('faculty_id', f.id, 'short_code', f.short_code, 'full_name', f.full_name)
                            ORDER BY lower(f.short_code)) FILTER (WHERE f.id IS NOT NULL), '[]'::jsonb) AS faculty
    FROM planner_sessions s
    JOIN planner_offerings o ON o.id = s.offering_id
    JOIN planner_divisions d ON d.id = o.division_id
    JOIN planner_subjects sub ON sub.id = o.subject_id
    JOIN planner_batches b ON b.id = s.batch_id
    LEFT JOIN planner_session_faculty sf ON sf.session_id = s.id
    LEFT JOIN planner_faculty f ON f.id = sf.faculty_id
   WHERE s.version_id = $1 AND ($2::uuid IS NULL OR o.division_id = $2) AND ($3::uuid[] IS NULL OR s.id = ANY($3))
   GROUP BY s.id, sub.code, sub.name, sub.kind, sub.duration_min, b.name, d.semester, d.name
   ORDER BY d.semester, lower(d.name), lower(sub.code), lower(b.name), s.seq`;

/**
 * Sessions of a version in the public shape (subject/batch names, faculty[]), optionally limited to one
 * division and/or a list of session ids. Shared by GET /sessions, the snapshot and the ops response.
 */
export async function loadSessions(db, versionId, { divisionId = null, ids = null } = {}) {
  const { rows } = await db.query(SESSION_SELECT, [versionId, divisionId ?? null, ids ?? null]);
  return rows;
}

export async function listSessions(versionId, query) {
  const { division_id } = parse(listQuery, query);
  await getVersion(pool, versionId);
  return loadSessions(pool, versionId, { divisionId: division_id ?? null });
}

/** The term a version belongs to (used for audit metadata). */
export async function versionTermId(versionId) {
  return (await getVersion(pool, versionId)).term_id;
}
