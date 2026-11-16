// The 15-division semester fixture (tests/planner/fixtures) as import rows, with every faculty
// short_code / email namespaced by the test file's uid so rows can be cleaned up by prefix.
import { FIXTURE_FACULTY, FIXTURE_SUBJECTS, buildDivisionRows, buildOfferingRows } from "../fixtures/semesterFixture.js";
import { pool, someRooms } from "./_util.js";

export function fixtureRows(s, { divisions = 15 } = {}) {
  const code = (c) => `${s.prefixCode}${c}`;
  return {
    faculty: FIXTURE_FACULTY.map(({ linked, ...f }) => ({ ...f, short_code: code(f.short_code), email: `${s.prefixCode.toLowerCase()}-${f.short_code.toLowerCase()}@zz-planner.invalid` })),
    subjects: FIXTURE_SUBJECTS.map((x) => ({ ...x, allow_second_lab: "no" })),
    divisions: buildDivisionRows(divisions),
    offerings: buildOfferingRows(divisions).map((o) => ({
      ...o,
      faculty_codes: o.faculty_codes.split(/[|,;]/).map((c) => code(c.trim())).join("|"),
    })),
  };
}

/** Imports one entity for real; returns the HTTP response. */
export const importEntity = (api, termId, entity, rows, dryRun = false) =>
  api("POST", `/terms/${termId}/import/${entity}?dryRun=${dryRun}`, { rows });

/** Imports faculty -> subjects -> divisions -> offerings, asserting nothing; returns the 4 responses. */
export async function importAll(api, termId, rows) {
  const out = {};
  for (const entity of ["faculty", "subjects", "divisions", "offerings"]) out[entity] = await importEntity(api, termId, entity, rows[entity]);
  return out;
}

/** 15 classrooms + 4 labs from the real room list, added to the term's pool. */
export async function addFixturePool(api, termId) {
  const { rows: classrooms } = await pool.query("SELECT id FROM rooms WHERE is_active AND room_type = 'classroom' ORDER BY name LIMIT 15");
  const labs = await someRooms(4, { lab: true });
  const res = await api("POST", `/terms/${termId}/rooms`, { room_ids: [...classrooms.map((r) => r.id), ...labs] });
  if (res.status !== 201) throw new Error(`pool add failed: ${JSON.stringify(res.body)}`);
  return res.body.rooms;
}
