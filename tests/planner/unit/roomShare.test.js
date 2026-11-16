import test from 'node:test';
import assert from 'node:assert/strict';
import { fitsInRoom, isShareable, peakLoad, studentsFor } from '../../../services/planner/domain/roomShare.js';

const iv = (start_min, end_min, students) => ({ start_min, end_min, students });
const lab = { kind: 'lab' };
const labRoom = { is_lab: true, capacity: 62 };

test('isShareable: only a lab subject in a lab room with a positive integer capacity', () => {
  assert.equal(isShareable({ subject: lab, poolRoom: labRoom }), true);
  assert.equal(isShareable({ subject: { kind: 'theory' }, poolRoom: labRoom }), false);
  assert.equal(isShareable({ subject: lab, poolRoom: { is_lab: false, capacity: 62 } }), false);
  assert.equal(isShareable({ subject: lab, poolRoom: { is_lab: true, capacity: null } }), false);
  assert.equal(isShareable({ subject: lab, poolRoom: { is_lab: true, capacity: undefined } }), false);
  assert.equal(isShareable({ subject: lab, poolRoom: { is_lab: true, capacity: 0 } }), false);
  assert.equal(isShareable({ subject: lab, poolRoom: { is_lab: true, capacity: -5 } }), false);
  assert.equal(isShareable({ subject: lab, poolRoom: { is_lab: true, capacity: 30.5 } }), false);
  assert.equal(isShareable({ subject: lab, poolRoom: { is_lab: true, capacity: '62' } }), false);
  assert.equal(isShareable({ subject: lab, poolRoom: { is_lab: 1, capacity: 62 } }), false);
  assert.equal(isShareable({ subject: lab }), false);
  assert.equal(isShareable({ poolRoom: labRoom }), false);
  assert.equal(isShareable(), false);
});

test('studentsFor: batch size, whole batch means the whole division, junk gives 0', () => {
  assert.equal(studentsFor({ batch: { is_whole: false, student_count: 30 }, division: { student_count: 60 } }), 30);
  assert.equal(studentsFor({ batch: { is_whole: true, student_count: 60 }, division: { student_count: 62 } }), 62);
  assert.equal(studentsFor({ division: { student_count: 60 } }), 60);
  assert.equal(studentsFor({ batch: { is_whole: false, student_count: null }, division: { student_count: 60 } }), 0);
  assert.equal(studentsFor(), 0);
});

test('fitsInRoom: empty room, exact fit and one over', () => {
  assert.deepEqual(fitsInRoom({ capacity: 62, existing: [], candidate: iv(540, 660, 30) }), { ok: true, peak: 30 });
  assert.deepEqual(fitsInRoom({ capacity: 30, existing: [], candidate: iv(540, 660, 30) }), { ok: true, peak: 30 });
  assert.deepEqual(fitsInRoom({ capacity: 29, existing: [], candidate: iv(540, 660, 30) }), { ok: false, peak: 30, capacity: 29 });
});

test('fitsInRoom: two batches of 30 share a 62 room, a third does not', () => {
  const two = [iv(540, 660, 30)];
  assert.deepEqual(fitsInRoom({ capacity: 62, existing: two, candidate: iv(540, 660, 30) }), { ok: true, peak: 60 });
  const three = [iv(540, 660, 30), iv(540, 660, 30)];
  assert.deepEqual(fitsInRoom({ capacity: 62, existing: three, candidate: iv(540, 660, 30) }), { ok: false, peak: 90, capacity: 62 });
  // ~65 tolerance is the admin's capacity choice, not ours: 62 + nothing
  assert.deepEqual(fitsInRoom({ capacity: 62, existing: [iv(540, 660, 31)], candidate: iv(540, 660, 31) }), { ok: true, peak: 62 });
  assert.deepEqual(fitsInRoom({ capacity: 62, existing: [iv(540, 660, 32)], candidate: iv(540, 660, 31) }), { ok: false, peak: 63, capacity: 62 });
});

test('fitsInRoom: half-open intervals, back-to-back sessions do not add up', () => {
  const existing = [iv(540, 600, 60)];
  assert.equal(fitsInRoom({ capacity: 62, existing, candidate: iv(600, 660, 60) }).ok, true);
  assert.equal(fitsInRoom({ capacity: 62, existing, candidate: iv(480, 540, 60) }).ok, true);
  assert.equal(fitsInRoom({ capacity: 62, existing, candidate: iv(599, 660, 60) }).ok, false);
  assert.equal(fitsInRoom({ capacity: 62, existing, candidate: iv(480, 541, 60) }).ok, false);
});

test('fitsInRoom: peak concurrency, not the sum of everything that overlaps the candidate', () => {
  // candidate 11:45-13:45 (705-825) sees 10:45-12:45 (645-765) and 12:45-14:45 (765-885), but never both at once
  const existing = [iv(645, 765, 30), iv(765, 885, 30)];
  assert.deepEqual(fitsInRoom({ capacity: 62, existing, candidate: iv(705, 825, 30) }), { ok: true, peak: 60 });
  // a naive sum would be 90 > 62; make them truly concurrent and it fails
  const concurrent = [iv(645, 825, 30), iv(705, 765, 30)];
  assert.deepEqual(fitsInRoom({ capacity: 62, existing: concurrent, candidate: iv(705, 825, 30) }), { ok: false, peak: 90, capacity: 62 });
});

test('fitsInRoom: the peak can sit in the middle of the candidate interval', () => {
  const existing = [iv(600, 660, 40)]; // sits inside the candidate 540-720
  assert.deepEqual(fitsInRoom({ capacity: 62, existing, candidate: iv(540, 720, 20) }), { ok: true, peak: 60 });
  assert.deepEqual(fitsInRoom({ capacity: 62, existing, candidate: iv(540, 720, 23) }), { ok: false, peak: 63, capacity: 62 });
  // existing that only touches the candidate from outside is ignored
  assert.deepEqual(fitsInRoom({ capacity: 62, existing: [iv(0, 540, 62), iv(720, 900, 62)], candidate: iv(540, 720, 62) }), { ok: true, peak: 62 });
});

test('fitsInRoom: existing sessions that overlap each other beyond the capacity count at their real overlap', () => {
  const existing = [iv(540, 600, 30), iv(570, 630, 30)]; // 60 together during 570-600
  assert.deepEqual(fitsInRoom({ capacity: 62, existing, candidate: iv(600, 660, 30) }), { ok: true, peak: 60 }); // 570-600 is before the candidate
  assert.equal(fitsInRoom({ capacity: 62, existing, candidate: iv(585, 660, 30) }).ok, false);
});

test('fitsInRoom never throws on junk', () => {
  assert.equal(fitsInRoom().ok, false);
  assert.equal(fitsInRoom({}).ok, false);
  assert.equal(fitsInRoom({ capacity: 62 }).ok, true); // nothing to place
  assert.equal(fitsInRoom({ capacity: 62, existing: null, candidate: iv(1, 2, 'x') }).ok, true);
  assert.equal(fitsInRoom({ capacity: 'a', existing: [null, 3, {}], candidate: iv(1, 2, 5) }).ok, false);
  assert.equal(fitsInRoom({ capacity: 10, existing: [iv(5, 5, 99), iv(9, 3, 99)], candidate: iv(0, 10, 5) }).ok, true, 'empty intervals add nothing');
  assert.deepEqual(fitsInRoom({ capacity: 10, existing: [], candidate: iv(10, 10, 12) }), { ok: false, peak: 12, capacity: 10 });
});

test('peakLoad clips to the window and ignores outside intervals', () => {
  assert.equal(peakLoad([iv(0, 100, 7), iv(50, 150, 5)], { start_min: 60, end_min: 80 }), 12);
  assert.equal(peakLoad([iv(0, 60, 7), iv(80, 150, 5)], { start_min: 60, end_min: 80 }), 0);
  assert.equal(peakLoad([iv(0, 100, 7)], { start_min: 80, end_min: 80 }), 0);
  assert.equal(peakLoad(null, null), 0);
});
