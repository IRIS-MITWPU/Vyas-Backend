import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtTime, weekdayName, fmtRange, describeConflict, describeCapacity } from '../../../services/planner/domain/explain.js';

const whole = {
  subject_code: 'OS',
  subject_name: 'Operating Systems',
  division_name: 'CSE-B',
  semester: 3,
  batch_name: 'ALL',
  is_whole: true,
};
const sub = { ...whole, subject_code: 'OSL', batch_name: 'B2', is_whole: false };

test('fmtTime pads and formats', () => {
  assert.equal(fmtTime(570), '09:30');
  assert.equal(fmtTime(0), '00:00');
  assert.equal(fmtTime(1065), '17:45');
  assert.equal(fmtTime(605), '10:05');
});

test('fmtTime tolerates bad input', () => {
  assert.equal(fmtTime(null), '--:--');
  assert.equal(fmtTime(undefined), '--:--');
  assert.equal(fmtTime(NaN), '--:--');
  assert.equal(fmtTime('570'), '--:--');
});

test('fmtRange uses an en dash', () => {
  assert.equal(fmtRange(570, 630), '09:30–10:30');
});

test('weekdayName maps 0..6 and tolerates out-of-range', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map(weekdayName),
    ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  );
  assert.equal(weekdayName(7), 'Day 7');
  assert.equal(weekdayName(-1), 'Day -1');
  assert.equal(weekdayName(null), 'Day null');
  assert.equal(weekdayName(undefined), 'Day undefined');
});

test('describeConflict faculty: whole-division holder', () => {
  assert.equal(
    describeConflict({ kind: 'faculty', resourceName: 'Prof. Sharma (SKS)', holder: whole, weekday: 0, start_min: 570, end_min: 630 }),
    'Prof. Sharma (SKS) is already teaching OS to CSE-B (Sem 3) on Monday 09:30–10:30.',
  );
});

test('describeConflict faculty: batch holder mentions the batch', () => {
  assert.equal(
    describeConflict({ kind: 'faculty', resourceName: 'Dr. A B (AB)', holder: sub, weekday: 2, start_min: 840, end_min: 960 }),
    'Dr. A B (AB) is already teaching OSL to CSE-B (Sem 3) batch B2 on Wednesday 14:00–16:00.',
  );
});

test('describeConflict room: whole and batch holders', () => {
  assert.equal(
    describeConflict({ kind: 'room', resourceName: 'LH-101', holder: whole, weekday: 1, start_min: 510, end_min: 570 }),
    'Room LH-101 is already used by OS for CSE-B (Sem 3) on Tuesday 08:30–09:30.',
  );
  assert.equal(
    describeConflict({ kind: 'room', resourceName: 'Lab 2', holder: sub, weekday: 4, start_min: 645, end_min: 765 }),
    'Room Lab 2 is already used by OSL for CSE-B (Sem 3) batch B2 on Friday 10:45–12:45.',
  );
});

test('describeConflict batch: whole holder and sub-batch holder', () => {
  assert.equal(
    describeConflict({ kind: 'batch', resourceName: 'x', holder: whole, weekday: 0, start_min: 570, end_min: 630 }),
    'CSE-B (Sem 3) already has OS on Monday 09:30–10:30.',
  );
  assert.equal(
    describeConflict({ kind: 'batch', resourceName: 'x', holder: sub, weekday: 0, start_min: 570, end_min: 690 }),
    'CSE-B (Sem 3) batch B2 already has OSL on Monday 09:30–11:30.',
  );
});

test('describeConflict tolerates missing pieces and unknown kinds', () => {
  assert.equal(
    describeConflict({ kind: 'batch', holder: { subject_code: 'OS', division_name: 'CSE-B' }, weekday: 0, start_min: 510, end_min: 570 }),
    'CSE-B already has OS on Monday 08:30–09:30.',
  );
  assert.equal(
    describeConflict({ kind: 'room', resourceName: 'R1', holder: { ...sub, batch_name: '' }, weekday: 0, start_min: 510, end_min: 570 }),
    'Room R1 is already used by OSL for CSE-B (Sem 3) on Monday 08:30–09:30.',
  );
  assert.equal(typeof describeConflict(), 'string');
  assert.equal(typeof describeConflict({ kind: 'weird', holder: null }), 'string');
  assert.match(
    describeConflict({ kind: 'weird', resourceName: 'Thing', holder: whole, weekday: 0, start_min: 510, end_min: 570 }),
    /Thing is already booked by OS on Monday 08:30/,
  );
});

test('describeCapacity: the sentence for a shared lab room that is full', () => {
  const a = { subject_code: 'LB', subject_name: 'Lab', division_name: 'CSE-A', semester: 3, batch_name: 'A1', is_whole: false, students: 30 };
  const b = { ...a, division_name: 'CSE-B', batch_name: 'B1' };
  assert.equal(
    describeCapacity({ roomName: 'VY 027', capacity: 62, peak: 90, weekday: 0, start_min: 510, end_min: 630, holders: [a, b] }),
    'Room VY 027 (capacity 62) would hold 90 students on Monday 08:30–10:30; it already has LB for CSE-A (Sem 3) batch A1 (30 students) and LB for CSE-B (Sem 3) batch B1 (30 students).',
  );
  assert.equal(
    describeCapacity({ roomName: 'VY 027', capacity: 62, peak: 70, weekday: 4, start_min: 645, end_min: 765, holders: [a] }),
    'Room VY 027 (capacity 62) would hold 70 students on Friday 10:45–12:45; it already has LB for CSE-A (Sem 3) batch A1 (30 students).',
  );
  const c = { ...a, division_name: 'CSE-C', batch_name: 'C1' };
  assert.equal(
    describeCapacity({ roomName: 'R', capacity: 62, peak: 120, weekday: 1, start_min: 510, end_min: 570, holders: [a, b, c] }),
    'Room R (capacity 62) would hold 120 students on Tuesday 08:30–09:30; it already has LB for CSE-A (Sem 3) batch A1 (30 students), LB for CSE-B (Sem 3) batch B1 (30 students) and LB for CSE-C (Sem 3) batch C1 (30 students).',
  );
  // whole-batch holder: no batch suffix; singular student
  assert.equal(
    describeCapacity({ roomName: 'R', capacity: 5, peak: 6, weekday: 0, start_min: 0, end_min: 60, holders: [{ ...a, is_whole: true, batch_name: 'ALL', students: 1 }] }),
    'Room R (capacity 5) would hold 6 students on Monday 00:00–01:00; it already has LB for CSE-A (Sem 3) (1 student).',
  );
  // nothing else in the room (a single oversized session): no "already has" part
  assert.equal(
    describeCapacity({ roomName: 'R', capacity: 62, peak: 70, weekday: 0, start_min: 510, end_min: 570, holders: [] }),
    'Room R (capacity 62) would hold 70 students on Monday 08:30–09:30.',
  );
  // never throws on junk
  assert.equal(typeof describeCapacity(), 'string');
  assert.equal(typeof describeCapacity({ holders: [null, 3, {}] }), 'string');
});
