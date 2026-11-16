import { requireTerm } from "./terms.js";
import { loadPoolRooms } from "./rooms.js";
import { loadDivisions } from "./divisions.js";
import { loadOfferings } from "./offerings.js";

/** Term subjects, ordered by code. */
export async function loadSubjects(db, termId) {
  const { rows } = await db.query(
    `SELECT id, term_id, code, name, kind, duration_min, weekly_count, semester_total, allow_second_lab
       FROM planner_subjects WHERE term_id = $1 ORDER BY lower(code), code`,
    [termId]
  );
  return rows;
}

/** Only the faculty that is assigned to at least one offering of the term (what readiness expects). */
async function loadUsedFaculty(db, termId) {
  const { rows } = await db.query(
    `SELECT f.id, f.profile_id, f.short_code, f.full_name, f.email, f.max_per_day, f.max_per_week
       FROM planner_faculty f
      WHERE f.id IN (SELECT ofa.faculty_id FROM planner_offering_faculty ofa
                       JOIN planner_offerings o ON o.id = ofa.offering_id
                       JOIN planner_divisions d ON d.id = o.division_id
                      WHERE d.term_id = $1)
      ORDER BY lower(f.short_code)`,
    [termId]
  );
  return rows;
}

/** Complete domain `state` of a term: { term, rooms, faculty, subjects, divisions, offerings }. */
export async function loadTermState(db, termId) {
  const term = await requireTerm(db, termId);
  // sequential on purpose: one client runs one query at a time
  const rooms = await loadPoolRooms(db, termId);
  const faculty = await loadUsedFaculty(db, termId);
  const subjects = await loadSubjects(db, termId);
  const divisions = await loadDivisions(db, termId);
  const offerings = await loadOfferings(db, termId);
  return { term, rooms, faculty, subjects, divisions, offerings };
}
