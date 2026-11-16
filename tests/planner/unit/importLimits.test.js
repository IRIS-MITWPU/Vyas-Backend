import test from 'node:test';
import assert from 'node:assert/strict';
import { validateImportRows, groupImportRows } from '../../../services/planner/domain/importSpec.js';
import { LIMITS, INT4_MAX } from '../../../services/planner/domain/limits.js';

const ctx = {
  term: { theory_minutes: 60, lab_minutes: 120, grid_minutes: 15 },
  faculty: { sharma: { id: 'f1' }, patil: { id: 'f2' } },
  subjects: { ds: { id: 's1', kind: 'theory' }, 'ds lab': { id: 's2', kind: 'lab' } },
  divisions: { '3|cse-a': { id: 'd1', batches: ['A1', 'A2', 'A3'] } },
  rooms: {},
  offerings: {},
};
const one = (entity, row, c = ctx) => validateImportRows(entity, [row], c)[0];
const fields = (r) => r.errors.map((e) => e.field);

// ---- upper bounds (shared with the API schemas through domain/limits.js)
test('limits: one shared constant set, with an int4 ceiling', () => {
  assert.ok(INT4_MAX < 2 ** 31);
  assert.equal(LIMITS.weekly_count.max, 100);
  assert.equal(LIMITS.semester_total.max, 10000);
  assert.equal(LIMITS.short_code, 40);
});

test('limits: out-of-range numbers are row errors, not silent overflow', () => {
  const subj = (extra) => ({ code: 'X', name: 'X', kind: 'theory', weekly_count: 1, ...extra });
  assert.deepEqual(fields(one('subjects', subj({ weekly_count: 5000000 }))), ['weekly_count']);
  assert.deepEqual(fields(one('subjects', subj({ weekly_count: 101 }))), ['weekly_count']);
  assert.equal(one('subjects', subj({ weekly_count: 100 })).status, 'create');
  assert.deepEqual(fields(one('subjects', subj({ semester_total: 99999999999 }))), ['semester_total']);
  assert.deepEqual(fields(one('subjects', subj({ semester_total: '99999999999999999999999' }))), ['semester_total']);
  assert.deepEqual(fields(one('subjects', subj({ semester_total: 10001 }))), ['semester_total']);
  assert.deepEqual(fields(one('subjects', subj({ duration_min: 1441 }))), ['duration_min']);
  const fac = (extra) => ({ short_code: 'Z', full_name: 'Z', ...extra });
  assert.deepEqual(fields(one('faculty', fac({ max_per_day: 101 }))), ['max_per_day']);
  assert.deepEqual(fields(one('faculty', fac({ max_per_week: 1001 }))), ['max_per_week']);
  assert.deepEqual(fields(one('faculty', fac({ max_per_week: 99999999999 }))), ['max_per_week']);
  const div = (extra) => ({ semester: 3, division: 'A', student_count: 60, ...extra });
  assert.deepEqual(fields(one('divisions', div({ student_count: 100001 }))), ['student_count']);
  assert.deepEqual(fields(one('divisions', div({ student_count: 100000, batch: 'A1', batch_size: 100001 }))), ['batch_size']);
  assert.deepEqual(fields(one('divisions', div({ semester: 13 }))), ['semester']);
  assert.deepEqual(fields(one('offerings', { semester: 3, division: 'CSE-A', subject_code: 'DS', faculty_codes: 'Sharma', weekly_count: 5000000 })), ['weekly_count']);
});

test('limits: over-long text is a row error and is not echoed in full', () => {
  const long = 'x'.repeat(5000);
  const r = one('faculty', { short_code: long, full_name: 'Z' });
  assert.equal(r.status, 'error');
  assert.deepEqual(fields(r), ['short_code']);
  assert.ok(r.errors[0].message.length < 200);
  assert.deepEqual(fields(one('faculty', { short_code: 'Z', full_name: 'y'.repeat(121) })), ['full_name']);
  assert.deepEqual(fields(one('faculty', { short_code: 'Z', full_name: 'Z', department: 'd'.repeat(121) })), ['department']);
  assert.deepEqual(fields(one('faculty', { short_code: 'Z', full_name: 'Z', email: `${'a'.repeat(300)}@mitwpu.edu.in` })), ['email']);
  assert.deepEqual(fields(one('subjects', { code: long, name: 'N', kind: 'theory', weekly_count: 1 })), ['code']);
  assert.deepEqual(fields(one('subjects', { code: 'C', name: 'n'.repeat(201), kind: 'theory', weekly_count: 1 })), ['name']);
  assert.deepEqual(fields(one('divisions', { semester: 3, division: 'd'.repeat(61), student_count: 10 })), ['division']);
  assert.deepEqual(fields(one('divisions', { semester: 3, division: 'A', student_count: 10, batch: 'b'.repeat(41), batch_size: 1 })), ['batch']);
  assert.deepEqual(fields(one('divisions', { semester: 3, division: 'A', student_count: 10, home_room: `B / ${'r'.repeat(400)}` })), ['home_room']);
  assert.ok(fields(one('offerings', { semester: 3, division: 'CSE-A', subject_code: long, faculty_codes: 'Sharma' })).includes('subject_code'));
  assert.ok(fields(one('offerings', { semester: 3, division: 'CSE-A', subject_code: 'DS', faculty_codes: long })).includes('faculty_codes'));
  const many = Array.from({ length: 201 }, (_, i) => `F${i}`).join('|');
  assert.ok(fields(one('offerings', { semester: 3, division: 'CSE-A', subject_code: 'DS', faculty_codes: many })).includes('faculty_codes'));
});

test('limits: values exactly at the limit are accepted', () => {
  assert.equal(one('faculty', { short_code: 'x'.repeat(40), full_name: 'y'.repeat(120), max_per_day: 100, max_per_week: 1000 }).status, 'create');
  assert.equal(one('subjects', { code: 'c'.repeat(40), name: 'n'.repeat(200), kind: 'lab', weekly_count: 100, semester_total: 10000, duration_min: 1440 }).status, 'create');
  assert.equal(one('divisions', { semester: 12, division: 'd'.repeat(60), student_count: 100000, batch: 'b'.repeat(40), batch_size: 100000 }).status, 'create');
});

// ---- blank optional values keep the stored value on UPDATE
test('subjects: blank duration_min / allow_second_lab = keep (null) on update, default on create', () => {
  const upd = one('subjects', { code: 'DS', name: 'Data Structures', kind: 'theory', weekly_count: 4 });
  assert.equal(upd.status, 'update');
  assert.equal(upd.normalized.duration_min, null);
  assert.equal(upd.normalized.allow_second_lab, null);
  const given = one('subjects', { code: 'DS', name: 'x', kind: 'theory', weekly_count: 4, duration_min: 45, allow_second_lab: 'no' });
  assert.equal(given.normalized.duration_min, 45);
  assert.equal(given.normalized.allow_second_lab, false);
  const create = one('subjects', { code: 'NEW', name: 'x', kind: 'lab', weekly_count: 1 });
  assert.equal(create.status, 'create');
  assert.equal(create.normalized.duration_min, 120);
  assert.equal(create.normalized.allow_second_lab, false);
});

test('divisions: blank batch_size keeps the stored size for an existing batch, warns for a new one', () => {
  const existing = one('divisions', { semester: 3, division: 'CSE-A', student_count: 60, batch: 'a2' });
  assert.equal(existing.status, 'update');
  assert.deepEqual(existing.warnings, []);
  assert.equal(existing.normalized.batch.student_count, null);
  const fresh = one('divisions', { semester: 3, division: 'CSE-A', student_count: 60, batch: 'A9' });
  assert.equal(fresh.warnings.length, 1);
  assert.equal(fresh.warnings[0].field, 'batch_size');
  assert.equal(fresh.normalized.batch.student_count, null);
  const newDivision = one('divisions', { semester: 7, division: 'Q', student_count: 60, batch: 'A1' });
  assert.equal(newDivision.warnings[0].field, 'batch_size');
  assert.equal(one('divisions', { semester: 3, division: 'CSE-A', student_count: 60, batch: 'A2', batch_size: 15 }).normalized.batch.student_count, 15);
  const grouped = groupImportRows('divisions', validateImportRows('divisions', [{ semester: 3, division: 'CSE-A', student_count: 60, batch: 'A2' }], ctx));
  assert.equal(grouped[0].batches[0].student_count, null);
});
