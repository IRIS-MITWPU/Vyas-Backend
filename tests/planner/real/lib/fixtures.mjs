// Reads the generated fixture files (tests/planner/fixtures/real). The only file I/O in lib/ besides report writing.
// NEVER touches the admin's workbooks: only the CSV/JSON inputs generated beforehand.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCsv } from './csv.mjs';

export const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = join(HERE, '..', 'fixtures', 'real');

// The real-data inputs are derived from private workbooks and are gitignored. Tests that need them
// skip themselves (`{ skip: SKIP_REAL }`) when the files are absent, e.g. on a fresh clone.
export const REAL_FILES = ['faculty.csv', 'subjects.csv', 'divisions.csv', 'offerings.csv', 'rooms_snapshot.json', 'lab_rooms.json', 'pattern_stats.json'];
export const HAS_REAL = REAL_FILES.every((f) => existsSync(join(FIXTURES, f)));
export const SKIP_REAL = HAS_REAL ? false : 'real-data fixtures not present (gitignored)';

export const readText = (name) => readFileSync(join(FIXTURES, name), 'utf8');
export const readJson = (name) => JSON.parse(readText(name));

/** The four import files, parsed in import order: faculty -> subjects -> divisions -> offerings. */
export function loadImportRows() {
  return {
    faculty: parseCsv(readText('faculty.csv')),
    subjects: parseCsv(readText('subjects.csv')),
    divisions: parseCsv(readText('divisions.csv')),
    offerings: parseCsv(readText('offerings.csv')),
  };
}
