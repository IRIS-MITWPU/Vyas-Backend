import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseCsvRows } from './lib/csv.mjs';
import { loadImportRows, SKIP_REAL } from './lib/fixtures.mjs';

test('csv: quoted fields, doubled quotes, embedded commas and newlines', () => {
  const rows = parseCsvRows('a,b,c\n"x,1","he said ""hi""","line1\nline2"\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['x,1', 'he said "hi"', 'line1\nline2']]);
});

test('csv: CRLF, BOM, blank trailing lines and short rows', () => {
  const rows = parseCsv('﻿k,v\r\n1,2\r\n3\r\n\r\n');
  assert.deepEqual(rows, [{ k: '1', v: '2' }, { k: '3', v: '' }]);
});

test('csv: empty input', () => {
  assert.deepEqual(parseCsv(''), []);
});

test('csv: the four real import files parse with the documented headers', { skip: SKIP_REAL }, () => {
  const r = loadImportRows();
  assert.ok(r.faculty.length > 100 && 'short_code' in r.faculty[0] && 'full_name' in r.faculty[0]);
  assert.ok(r.subjects.length > 50 && 'weekly_count' in r.subjects[0] && 'duration_min' in r.subjects[0]);
  assert.ok(r.divisions.length > 90 && 'batch_size' in r.divisions[0] && 'home_room' in r.divisions[0]);
  assert.ok(r.offerings.length > 300 && 'faculty_codes' in r.offerings[0]);
});
