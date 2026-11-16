/**
 * Regenerates faculty.csv, subjects.csv, divisions.csv, offerings.csv from semesterFixture.js.
 *   node tests/planner/fixtures/generateCsv.js
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { FIXTURE_FACULTY, FIXTURE_SUBJECTS, buildDivisionRows, buildOfferingRows } from './semesterFixture.js';

export function toCsv(columns, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

export function allCsv(count = 15) {
  return {
    'faculty.csv': toCsv(['short_code', 'full_name', 'email', 'department', 'max_per_day', 'max_per_week'], FIXTURE_FACULTY),
    'subjects.csv': toCsv(
      ['code', 'name', 'kind', 'weekly_count', 'semester_total', 'allow_second_lab', 'duration_min'],
      FIXTURE_SUBJECTS.map((s) => ({ ...s, allow_second_lab: 'no' })),
    ),
    'divisions.csv': toCsv(['semester', 'division', 'student_count', 'home_room', 'batch', 'batch_size'], buildDivisionRows(count)),
    'offerings.csv': toCsv(['semester', 'division', 'subject_code', 'faculty_codes', 'batch', 'weekly_count', 'role'], buildOfferingRows(count)),
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [name, text] of Object.entries(allCsv())) writeFileSync(path.join(here, name), text);
  console.log('CSV fixtures written to', here);
}
