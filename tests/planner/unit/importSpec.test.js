import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMPORT_ENTITIES,
  IMPORT_TEMPLATES,
  validateImportRows,
  groupImportRows,
} from '../../../services/planner/domain/importSpec.js';
import { allCsv } from '../fixtures/generateCsv.js';
import { buildSemesterState, buildOfferingRows, buildDivisionRows, FIXTURE_FACULTY, FIXTURE_SUBJECTS } from '../fixtures/semesterFixture.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ctx = {
  term: { theory_minutes: 60, lab_minutes: 120, grid_minutes: 15 },
  faculty: { sharma: { id: 'f1' }, patil: { id: 'f2' } },
  subjects: { ds: { id: 's1', kind: 'theory' }, 'ds lab': { id: 's2', kind: 'lab' } },
  divisions: { '3|cse-a': { id: 'd1', batches: ['A1', 'A2', 'A3'] }, '5|cse-b': { id: 'd2' } },
  rooms: { 'main building / 101': { id: 'r1' }, 'main building / dup': [{ id: 'r2' }, { id: 'r3' }] },
  offerings: { '3|cse-a|ds': { id: 'o1' } },
};

const one = (entity, row, c = ctx) => validateImportRows(entity, [row], c)[0];
const fields = (r) => r.errors.map((e) => e.field);

test('entities and templates', () => {
  assert.deepEqual([...IMPORT_ENTITIES], ['faculty', 'subjects', 'divisions', 'offerings']);
  const expectedRequired = {
    faculty: ['short_code', 'full_name'],
    subjects: ['code', 'name', 'kind', 'weekly_count'],
    divisions: ['semester', 'division', 'student_count'],
    offerings: ['semester', 'division', 'subject_code', 'faculty_codes'],
  };
  const expectedKeys = {
    faculty: ['short_code', 'full_name', 'email', 'department', 'max_per_day', 'max_per_week'],
    subjects: ['code', 'name', 'kind', 'weekly_count', 'semester_total', 'allow_second_lab', 'duration_min'],
    divisions: ['semester', 'division', 'student_count', 'home_room', 'batch', 'batch_size'],
    offerings: ['semester', 'division', 'subject_code', 'faculty_codes', 'batch', 'weekly_count', 'role'],
  };
  for (const e of IMPORT_ENTITIES) {
    const t = IMPORT_TEMPLATES[e];
    assert.deepEqual(t.columns.map((c) => c.key), expectedKeys[e]);
    assert.deepEqual(t.columns.filter((c) => c.required).map((c) => c.key), expectedRequired[e]);
    for (const c of t.columns) {
      assert.equal(typeof c.label, 'string');
      assert.equal(typeof c.description, 'string');
      assert.ok('example' in c);
    }
    assert.ok(t.sample_rows.length >= 3);
    for (const r of t.sample_rows) for (const k of Object.keys(r)) assert.ok(expectedKeys[e].includes(k), `${e}.${k}`);
  }
});

test('template sample rows form a valid worked example when imported in order', () => {
  const T = IMPORT_TEMPLATES;
  const fac = validateImportRows('faculty', T.faculty.sample_rows, {});
  assert.ok(fac.every((r) => r.status === 'create'), JSON.stringify(fac));
  assert.deepEqual(T.faculty.sample_rows.map((r) => r.short_code), ['Sharma', 'Patil', 'Kulkarni']);
  const c = { faculty: Object.fromEntries(T.faculty.sample_rows.map((r) => [r.short_code.toLowerCase(), { id: r.short_code }])) };
  const sub = validateImportRows('subjects', T.subjects.sample_rows, c);
  assert.ok(sub.every((r) => r.status === 'create'), JSON.stringify(sub));
  assert.deepEqual(T.subjects.sample_rows.map((r) => r.code), ['DS', 'OS', 'Maths', 'CN', 'DS Lab']);
  c.subjects = Object.fromEntries(T.subjects.sample_rows.map((r) => [r.code.toLowerCase(), { id: r.code }]));
  const div = validateImportRows('divisions', T.divisions.sample_rows, {});
  assert.ok(div.every((r) => r.status === 'create' || r.errors.every((e) => e.field === 'home_room')), JSON.stringify(div));
  c.divisions = { '3|cse-a': { id: 'd', batches: ['A1', 'A2', 'A3'] } };
  const off = validateImportRows('offerings', T.offerings.sample_rows, c);
  assert.ok(off.every((r) => r.status === 'create'), JSON.stringify(off));
});

// ---------------------------------------------------------------- general robustness
test('never throws on garbage input', () => {
  const garbage = [null, undefined, 5, 'x', [], [1, 2], {}, { a: { b: 1 } }, () => 1, Symbol.iterator && {}];
  for (const e of [...IMPORT_ENTITIES, 'nope', null, 42]) {
    for (const c of [undefined, null, 5, {}, { faculty: 5, rooms: 'x' }, ctx]) {
      const out = validateImportRows(e, garbage, c);
      assert.ok(Array.isArray(out));
    }
  }
  assert.deepEqual(validateImportRows('faculty', null, ctx), []);
  assert.deepEqual(validateImportRows('faculty', 'abc', ctx), []);
});

test('non-object rows become error rows; blank rows are skipped', () => {
  const out = validateImportRows('faculty', [null, 5, [], {}, { short_code: '', full_name: '  ' }, { short_code: 'A', full_name: 'B' }], {});
  assert.deepEqual(out.map((r) => [r.row, r.status]), [[1, 'error'], [2, 'error'], [3, 'error'], [6, 'create']]);
  assert.equal(out[0].normalized, null);
});

test('unknown entity gives an error per row', () => {
  const out = validateImportRows('rooms', [{ a: 1 }, { b: 2 }], ctx);
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => r.status === 'error' && r.errors[0].field === 'entity'));
});

test('row numbers are 1-based positions', () => {
  const out = validateImportRows('faculty', [{ short_code: 'A', full_name: 'A' }, { short_code: 'B', full_name: 'B' }], {});
  assert.deepEqual(out.map((r) => r.row), [1, 2]);
});

test('headers are case-insensitive and trimmed; values trimmed; empty string is null', () => {
  const r = one('faculty', { ' Short_Code ': '  Sharma  ', FULL_NAME: ' Anil ', Email: '', DEPARTMENT: ' CS ', Max_Per_Day: '' });
  assert.equal(r.status, 'update');
  assert.deepEqual(r.normalized, { short_code: 'Sharma', full_name: 'Anil', email: null, department: 'CS', max_per_day: null, max_per_week: null });
});

test('ctx collections can be maps, sets, arrays or objects', () => {
  const row = { short_code: 'Sharma', full_name: 'A' };
  assert.equal(one('faculty', row, { faculty: new Map([['sharma', 1]]) }).status, 'update');
  assert.equal(one('faculty', row, { faculty: new Set(['sharma']) }).status, 'update');
  assert.equal(one('faculty', row, { faculty: ['SHARMA'] }).status, 'update');
  assert.equal(one('faculty', row, { faculty: { Sharma: 1 } }).status, 'update');
});

// ---------------------------------------------------------------- faculty
test('faculty: happy path create with parsing', () => {
  const r = one('faculty', { short_code: 'Kale', full_name: 'Pooja Kale', email: 'Pooja.Kale@MITWPU.edu.in', department: 'CS', max_per_day: '4', max_per_week: '16.0' });
  assert.equal(r.status, 'create');
  assert.equal(r.key, 'kale');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.normalized, { short_code: 'Kale', full_name: 'Pooja Kale', email: 'pooja.kale@mitwpu.edu.in', department: 'CS', max_per_day: 4, max_per_week: 16 });
});

test('faculty: numeric cells (xlsx) work', () => {
  const r = one('faculty', { short_code: 'Kale', full_name: 'K', max_per_day: 4, max_per_week: 16 });
  assert.equal(r.normalized.max_per_day, 4);
});

test('faculty: existing short_code (case-insensitive) is an update', () => {
  assert.equal(one('faculty', { short_code: 'SHARMA', full_name: 'X' }).status, 'update');
  assert.equal(one('faculty', { short_code: 'SHARMA', full_name: 'X' }).key, 'sharma');
});

test('faculty: errors - required fields, bad email, bad numbers, reserved characters', () => {
  assert.deepEqual(fields(one('faculty', { short_code: 'A' })), ['full_name']);
  assert.deepEqual(fields(one('faculty', { full_name: 'A' })), ['short_code']);
  assert.deepEqual(fields(one('faculty', { short_code: 'A', full_name: 'B', email: 'not-an-email' })), ['email']);
  assert.deepEqual(fields(one('faculty', { short_code: 'A', full_name: 'B', max_per_day: 'abc' })), ['max_per_day']);
  assert.deepEqual(fields(one('faculty', { short_code: 'A', full_name: 'B', max_per_week: '0' })), ['max_per_week']);
  assert.deepEqual(fields(one('faculty', { short_code: 'A', full_name: 'B', max_per_week: '2.5' })), ['max_per_week']);
  assert.deepEqual(fields(one('faculty', { short_code: 'A|B', full_name: 'B' })), ['short_code']);
  assert.equal(one('faculty', { short_code: 'A', full_name: 'B', email: 'x' }).status, 'error');
});

test('faculty: duplicate short_code in the file errors the later row', () => {
  const out = validateImportRows('faculty', [{ short_code: 'Zed', full_name: 'A' }, { short_code: 'zed', full_name: 'B' }], {});
  assert.equal(out[0].status, 'create');
  assert.equal(out[1].status, 'error');
  assert.match(out[1].errors[0].message, /row 1/);
});

test('faculty: max_per_day above max_per_week is a warning', () => {
  const r = one('faculty', { short_code: 'N', full_name: 'N', max_per_day: 9, max_per_week: 4 });
  assert.equal(r.status, 'create');
  assert.equal(r.warnings.length, 1);
});

// ---------------------------------------------------------------- subjects
test('subjects: happy path, booleans and default durations', () => {
  const r = one('subjects', { code: 'CN', name: 'Computer Networks', kind: 'Theory', weekly_count: '3', semester_total: '45.0', allow_second_lab: 'Yes' });
  assert.equal(r.status, 'create');
  assert.deepEqual(r.normalized, { code: 'CN', name: 'Computer Networks', kind: 'theory', weekly_count: 3, semester_total: 45, allow_second_lab: true, duration_min: 60 });
  const lab = one('subjects', { code: 'L', name: 'L', kind: 'lab', weekly_count: 1 });
  assert.equal(lab.normalized.duration_min, 120);
  assert.equal(lab.normalized.allow_second_lab, false);
  assert.equal(lab.normalized.semester_total, null);
  assert.equal(one('subjects', { code: 'L', name: 'L', kind: 'lab', weekly_count: 1 }, {}).normalized.duration_min, 120);
  assert.equal(one('subjects', { code: 'L', name: 'L', kind: 'lab', weekly_count: 1, duration_min: '90' }).normalized.duration_min, 90);
});

test('subjects: all boolean spellings', () => {
  const val = (v) => one('subjects', { code: 'X', name: 'X', kind: 'lab', weekly_count: 1, allow_second_lab: v });
  for (const t of ['yes', 'TRUE', '1', 'y', true, 1]) assert.equal(val(t).normalized.allow_second_lab, true, String(t));
  for (const f of ['no', 'False', '0', 'n', false, 0]) assert.equal(val(f).normalized.allow_second_lab, false, String(f));
  assert.deepEqual(fields(val('maybe')), ['allow_second_lab']);
});

test('subjects: create vs update by code', () => {
  assert.equal(one('subjects', { code: 'DS', name: 'x', kind: 'theory', weekly_count: 1 }).status, 'update');
  assert.equal(one('subjects', { code: 'ds lab', name: 'x', kind: 'lab', weekly_count: 1 }).status, 'update');
  assert.equal(one('subjects', { code: 'New', name: 'x', kind: 'theory', weekly_count: 1 }).status, 'create');
});

test('subjects: errors', () => {
  assert.deepEqual(fields(one('subjects', { code: 'X', name: 'X', kind: 'lecture', weekly_count: 1 })), ['kind']);
  assert.deepEqual(fields(one('subjects', { code: 'X', name: 'X', weekly_count: 1 })), ['kind']);
  assert.deepEqual(fields(one('subjects', { code: 'X', name: 'X', kind: 'lab' })), ['weekly_count']);
  assert.deepEqual(fields(one('subjects', { code: 'X', name: 'X', kind: 'lab', weekly_count: '-1' })), ['weekly_count']);
  assert.deepEqual(fields(one('subjects', { code: 'X', name: 'X', kind: 'lab', weekly_count: 'two' })), ['weekly_count']);
  assert.deepEqual(fields(one('subjects', { name: 'X', kind: 'lab', weekly_count: 1 })), ['code']);
  assert.deepEqual(fields(one('subjects', { code: 'X', kind: 'lab', weekly_count: 1 })), ['name']);
  assert.deepEqual(fields(one('subjects', { code: 'X', name: 'X', kind: 'lab', weekly_count: 1, duration_min: '0' })), ['duration_min']);
  assert.deepEqual(fields(one('subjects', { code: 'X', name: 'X', kind: 'lab', weekly_count: 1, semester_total: '-3' })), ['semester_total']);
});

test('subjects: weekly_count 0 is allowed; off-grid duration is a warning', () => {
  assert.equal(one('subjects', { code: 'X', name: 'X', kind: 'theory', weekly_count: 0 }).status, 'create');
  const r = one('subjects', { code: 'X', name: 'X', kind: 'theory', weekly_count: 1, duration_min: 50 });
  assert.equal(r.status, 'create');
  assert.equal(r.warnings[0].field, 'duration_min');
});

test('subjects: duplicate code in file', () => {
  const out = validateImportRows('subjects', [
    { code: 'Q', name: 'a', kind: 'theory', weekly_count: 1 },
    { code: 'q', name: 'b', kind: 'theory', weekly_count: 1 },
  ], {});
  assert.deepEqual(out.map((r) => r.status), ['create', 'error']);
});

// ---------------------------------------------------------------- divisions
test('divisions: happy path with batches and home room', () => {
  const rows = ['A1', 'A2', 'A3'].map((b) => ({ semester: '4.0', division: 'CSE-C', student_count: '60', home_room: 'Main Building / 101', batch: b, batch_size: 20 }));
  const out = validateImportRows('divisions', rows, ctx);
  assert.ok(out.every((r) => r.status === 'create'), JSON.stringify(out));
  assert.equal(out[0].key, '4|cse-c');
  assert.equal(out[0].normalized.home_room_id, 'r1');
  assert.deepEqual(out[0].normalized.batch, { name: 'A1', student_count: 20 });
  const [g] = groupImportRows('divisions', out);
  assert.equal(g.semester, 4);
  assert.equal(g.name, 'CSE-C');
  assert.equal(g.student_count, 60);
  assert.deepEqual(g.batches.map((b) => b.name), ['A1', 'A2', 'A3']);
});

test('divisions: division-only row, update status for existing division', () => {
  const r = one('divisions', { semester: 3, division: 'CSE-A', student_count: 55 });
  assert.equal(r.status, 'update');
  assert.equal(r.normalized.batch, null);
  assert.equal(r.normalized.home_room, null);
});

test('divisions: errors - semester, counts, home room format / unknown / ambiguous', () => {
  assert.deepEqual(fields(one('divisions', { semester: 0, division: 'A', student_count: 1 })), ['semester']);
  assert.deepEqual(fields(one('divisions', { semester: 13, division: 'A', student_count: 1 })), ['semester']);
  assert.deepEqual(fields(one('divisions', { semester: 'x', division: 'A', student_count: 1 })), ['semester']);
  assert.deepEqual(fields(one('divisions', { division: 'A', student_count: 1 })), ['semester']);
  assert.deepEqual(fields(one('divisions', { semester: 1, student_count: 1 })), ['division']);
  assert.deepEqual(fields(one('divisions', { semester: 1, division: 'A' })), ['student_count']);
  assert.deepEqual(fields(one('divisions', { semester: 1, division: 'A', student_count: -2 })), ['student_count']);
  assert.deepEqual(fields(one('divisions', { semester: 1, division: 'A', student_count: 1, home_room: '101' })), ['home_room']);
  assert.deepEqual(fields(one('divisions', { semester: 1, division: 'A', student_count: 1, home_room: 'Main Building / 999' })), ['home_room']);
  const amb = one('divisions', { semester: 1, division: 'A', student_count: 1, home_room: 'Main Building / dup' });
  assert.equal(amb.status, 'error');
  assert.match(amb.errors[0].message, /ambiguous/);
  assert.deepEqual(fields(one('divisions', { semester: 1, division: 'A', student_count: 10, batch: 'A1', batch_size: 30 })), ['batch_size']);
});

test('divisions: home_room is case-insensitive and tolerant of spacing', () => {
  const r = one('divisions', { semester: 1, division: 'A', student_count: 1, home_room: '  MAIN  building/101 ' });
  assert.equal(r.status, 'create');
  assert.equal(r.normalized.home_room_id, 'r1');
});

test('divisions: batch without size warns, size without batch warns', () => {
  assert.equal(one('divisions', { semester: 1, division: 'A', student_count: 9, batch: 'A1' }).warnings[0].field, 'batch_size');
  assert.equal(one('divisions', { semester: 1, division: 'A', student_count: 9, batch_size: 3 }).warnings[0].field, 'batch_size');
});

test('divisions: repeated division rows merge; conflicting student_count / home_room error on the later row', () => {
  const out = validateImportRows('divisions', [
    { semester: 1, division: 'A', student_count: 60, batch: 'A1', batch_size: 20 },
    { semester: 1, division: 'a', student_count: '60', home_room: 'Main Building / 101', batch: 'A2', batch_size: 20 },
    { semester: 1, division: 'A', student_count: 50, batch: 'A3', batch_size: 10 },
    { semester: 1, division: 'A', student_count: 60, home_room: 'Main Building / dup', batch: 'A4', batch_size: 1 },
  ], ctx);
  assert.deepEqual(out.map((r) => r.status), ['create', 'create', 'error', 'error']);
  assert.equal(out[2].errors[0].field, 'student_count');
  assert.match(out[2].errors[0].message, /row 1/);
  assert.equal(out[3].errors[0].field, 'home_room'); // ambiguous room
  const [g] = groupImportRows('divisions', out);
  assert.equal(g.home_room_id, 'r1'); // filled in from the row that had it
  assert.deepEqual(g.batches.map((b) => b.name), ['A1', 'A2']);
});

test('divisions: conflicting home_room between two valid rows', () => {
  const c = { ...ctx, rooms: { ...ctx.rooms, 'main building / 102': { id: 'r9' } } };
  const out = validateImportRows('divisions', [
    { semester: 1, division: 'A', student_count: 60, home_room: 'Main Building / 101', batch: 'A1', batch_size: 20 },
    { semester: 1, division: 'A', student_count: 60, home_room: 'Main Building / 102', batch: 'A2', batch_size: 20 },
  ], c);
  assert.deepEqual(out.map((r) => r.status), ['create', 'error']);
  assert.equal(out[1].errors[0].field, 'home_room');
});

test('divisions: duplicate batch or duplicate bare division row', () => {
  const out = validateImportRows('divisions', [
    { semester: 1, division: 'A', student_count: 60, batch: 'A1', batch_size: 20 },
    { semester: 1, division: 'A', student_count: 60, batch: 'a1', batch_size: 20 },
    { semester: 1, division: 'B', student_count: 60 },
    { semester: 1, division: 'B', student_count: 60 },
  ], {});
  assert.deepEqual(out.map((r) => r.status), ['create', 'error', 'create', 'error']);
});

test('divisions: same division name in different semesters is not a duplicate', () => {
  const out = validateImportRows('divisions', [
    { semester: 1, division: 'A', student_count: 60 },
    { semester: 2, division: 'A', student_count: 60 },
  ], {});
  assert.deepEqual(out.map((r) => r.status), ['create', 'create']);
});

test('divisions: reserved batch name ALL', () => {
  assert.deepEqual(fields(one('divisions', { semester: 1, division: 'A', student_count: 60, batch: 'all', batch_size: 60 })), ['batch']);
});

// ---------------------------------------------------------------- offerings
test('offerings: happy path, roles via suffix and default role', () => {
  const r = one('offerings', { semester: 3, division: 'CSE-A', subject_code: 'DS Lab', faculty_codes: 'Sharma | Patil:assist', batch: 'a1', weekly_count: '2', role: 'lead' });
  assert.equal(r.status, 'create');
  assert.equal(r.key, '3|cse-a|ds lab');
  assert.deepEqual(r.normalized.faculty, [
    { short_code: 'Sharma', faculty_id: 'f1', role: 'lead' },
    { short_code: 'Patil', faculty_id: 'f2', role: 'assist' },
  ]);
  assert.equal(r.normalized.weekly_count, 2);
  assert.equal(r.normalized.division_id, 'd1');
  assert.equal(r.normalized.subject_id, 's2');
  assert.equal(r.normalized.batch, 'a1');
});

test('offerings: separators | , ; and default role assist', () => {
  for (const sep of ['|', ',', ';', ' ; ']) {
    const r = one('offerings', { semester: 3, division: 'CSE-A', subject_code: 'DS', faculty_codes: `Sharma${sep}Patil`, role: 'assist' });
    assert.deepEqual(r.normalized.faculty.map((f) => [f.short_code, f.role]), [['Sharma', 'assist'], ['Patil', 'assist']], sep);
  }
  const mixed = one('offerings', { semester: 3, division: 'CSE-A', subject_code: 'DS', faculty_codes: 'Sharma:lead;Patil', role: 'assist' });
  assert.deepEqual(mixed.normalized.faculty.map((f) => f.role), ['lead', 'assist']);
});

test('offerings: create vs update', () => {
  assert.equal(one('offerings', { semester: 3, division: 'CSE-A', subject_code: 'DS', faculty_codes: 'Sharma' }).status, 'update');
  assert.equal(one('offerings', { semester: 3, division: 'CSE-A', subject_code: 'DS Lab', faculty_codes: 'Sharma' }).status, 'create');
});

test('offerings: blank batch and "ALL" mean all batches', () => {
  assert.equal(one('offerings', { semester: 3, division: 'CSE-A', subject_code: 'DS', faculty_codes: 'Sharma', batch: 'ALL' }).normalized.batch, null);
  assert.equal(one('offerings', { semester: 3, division: 'CSE-A', subject_code: 'DS', faculty_codes: 'Sharma' }).normalized.batch, null);
});

test('offerings: reference errors (faculty, subject, division, batch)', () => {
  const base = { semester: 3, division: 'CSE-A', subject_code: 'DS', faculty_codes: 'Sharma' };
  const unknownFac = one('offerings', { ...base, faculty_codes: 'Sharma|Nobody' });
  assert.deepEqual(fields(unknownFac), ['faculty_codes']);
  assert.match(unknownFac.errors[0].message, /Nobody/);
  assert.deepEqual(fields(one('offerings', { ...base, subject_code: 'ZZ' })), ['subject_code']);
  assert.deepEqual(fields(one('offerings', { ...base, division: 'CSE-Z' })), ['division']);
  assert.deepEqual(fields(one('offerings', { ...base, semester: 4 })), ['division']);
  assert.deepEqual(fields(one('offerings', { ...base, batch: 'Q9' })), ['batch']);
  assert.equal(one('offerings', { ...base, semester: 5, division: 'CSE-B', batch: 'whatever' }).status, 'create'); // batches unknown: not validated
});

test('offerings: other errors', () => {
  const base = { semester: 3, division: 'CSE-A', subject_code: 'DS', faculty_codes: 'Sharma' };
  assert.deepEqual(fields(one('offerings', { ...base, faculty_codes: '' })), ['faculty_codes']);
  assert.deepEqual(fields(one('offerings', { ...base, faculty_codes: ' ; | ' })), ['faculty_codes']);
  assert.deepEqual(fields(one('offerings', { ...base, faculty_codes: 'Sharma:boss' })), ['faculty_codes']);
  assert.deepEqual(fields(one('offerings', { ...base, role: 'boss' })), ['role']);
  assert.deepEqual(fields(one('offerings', { ...base, weekly_count: 'x' })), ['weekly_count']);
  assert.deepEqual(fields(one('offerings', { ...base, semester: '' })), ['semester']);
  assert.deepEqual(fields(one('offerings', { ...base, subject_code: '' })), ['subject_code']);
});

test('offerings: same faculty twice in one cell warns; with different roles errors', () => {
  const base = { semester: 3, division: 'CSE-A', subject_code: 'DS' };
  const same = one('offerings', { ...base, faculty_codes: 'Sharma|sharma' });
  assert.equal(same.status, 'update'); // 3|cse-a|ds already exists in ctx
  assert.equal(same.normalized.faculty.length, 1);
  assert.equal(same.warnings.length, 1);
  assert.equal(one('offerings', { ...base, faculty_codes: 'Sharma|sharma:assist' }).status, 'error');
});

test('offerings: rows for the same offering merge', () => {
  const out = validateImportRows('offerings', [
    { semester: 3, division: 'CSE-A', subject_code: 'DS Lab', faculty_codes: 'Sharma', batch: 'A1' },
    { semester: 3, division: 'cse-a', subject_code: 'ds lab', faculty_codes: 'Patil', batch: 'A2', weekly_count: 2 },
    { semester: 3, division: 'CSE-A', subject_code: 'DS Lab', faculty_codes: 'Patil:assist', batch: 'A1', weekly_count: '2.0' },
  ], ctx);
  assert.deepEqual(out.map((r) => r.status), ['create', 'create', 'create']);
  const [g, ...rest] = groupImportRows('offerings', out);
  assert.equal(rest.length, 0);
  assert.equal(g.weekly_count, 2); // taken from the first row that states it
  assert.deepEqual(g.faculty.map((f) => [f.batch, f.short_code, f.role]), [['A1', 'Sharma', 'lead'], ['A2', 'Patil', 'lead'], ['A1', 'Patil', 'assist']]);
});

test('offerings: disagreeing weekly_count errors on the later row', () => {
  const out = validateImportRows('offerings', [
    { semester: 3, division: 'CSE-A', subject_code: 'DS Lab', faculty_codes: 'Sharma', batch: 'A1', weekly_count: 1 },
    { semester: 3, division: 'CSE-A', subject_code: 'DS Lab', faculty_codes: 'Patil', batch: 'A2', weekly_count: 2 },
  ], ctx);
  assert.deepEqual(out.map((r) => r.status), ['create', 'error']);
  assert.equal(out[1].errors[0].field, 'weekly_count');
  assert.match(out[1].errors[0].message, /row 1/);
});

test('offerings: the same faculty on the same batch twice is a duplicate; different batch is fine', () => {
  const out = validateImportRows('offerings', [
    { semester: 3, division: 'CSE-A', subject_code: 'DS', faculty_codes: 'Sharma' },
    { semester: 3, division: 'CSE-A', subject_code: 'DS', faculty_codes: 'Sharma' },
    { semester: 3, division: 'CSE-A', subject_code: 'DS', faculty_codes: 'Sharma', batch: 'A1' },
  ], ctx);
  assert.deepEqual(out.map((r) => r.status), ['update', 'error', 'update']);
});

test('groupImportRows ignores error rows and handles garbage', () => {
  const out = validateImportRows('faculty', [{ short_code: 'A', full_name: 'A' }, { short_code: 'B' }], {});
  const g = groupImportRows('faculty', out);
  assert.equal(g.length, 1);
  assert.equal(g[0].short_code, 'A');
  assert.deepEqual(groupImportRows('divisions', null), []);
  assert.deepEqual(groupImportRows('x', [null]), []);
});

// ---------------------------------------------------------------- fixture CSV consistency
function parseCsv(text) {
  const [head, ...lines] = text.trim().split('\n');
  const keys = head.split(',');
  return lines.map((l) => {
    const cells = l.split(','); // fixtures contain no quoted commas
    return Object.fromEntries(keys.map((k, i) => [k, cells[i] ?? '']));
  });
}

test('fixture CSV files match the generator and validate end to end', () => {
  const dir = fileURLToPath(new URL('../fixtures/', import.meta.url));
  for (const [name, text] of Object.entries(allCsv())) {
    assert.equal(readFileSync(dir + name, 'utf8'), text, `${name} is stale: run node tests/planner/fixtures/generateCsv.js`);
  }
  const files = Object.fromEntries(['faculty', 'subjects', 'divisions', 'offerings'].map((n) => [n, parseCsv(readFileSync(`${dir}${n}.csv`, 'utf8'))]));
  const fac = validateImportRows('faculty', files.faculty, {});
  assert.equal(fac.length, 12);
  assert.ok(fac.every((r) => r.status === 'create'));
  const c = { faculty: Object.fromEntries(FIXTURE_FACULTY.map((f) => [f.short_code.toLowerCase(), { id: f.short_code }])) };
  const sub = validateImportRows('subjects', files.subjects, {});
  assert.equal(sub.length, 8);
  assert.ok(sub.every((r) => r.status === 'create'), JSON.stringify(sub.filter((r) => r.errors.length)));
  c.subjects = Object.fromEntries(FIXTURE_SUBJECTS.map((s) => [s.code.toLowerCase(), { id: s.code }]));
  const div = validateImportRows('divisions', files.divisions, {});
  assert.equal(div.length, 45);
  assert.ok(div.every((r) => r.status === 'create'), JSON.stringify(div.filter((r) => r.errors.length)));
  const divisions = groupImportRows('divisions', div);
  assert.equal(divisions.length, 15);
  c.divisions = Object.fromEntries(divisions.map((d) => [`${d.semester}|${d.name.toLowerCase()}`, { id: d.name, batches: d.batches.map((b) => b.name) }]));
  const off = validateImportRows('offerings', files.offerings, c);
  assert.equal(off.length, buildOfferingRows().length);
  assert.ok(off.every((r) => r.status === 'create'), JSON.stringify(off.filter((r) => r.errors.length).slice(0, 3)));
  const offerings = groupImportRows('offerings', off);
  assert.equal(offerings.length, buildSemesterState().offerings.length);
  assert.equal(buildDivisionRows().length, 45);
});
