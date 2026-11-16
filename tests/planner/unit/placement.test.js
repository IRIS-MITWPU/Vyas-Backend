import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPlacement, gridStep, overlapsBreak } from '../../../services/planner/domain/placement.js';

// Defaults: Mon-Fri, 08:30 (510) - 17:45 (1065), grid 15,
// breaks 10:30-10:45 (630-645), lunch 12:45-13:30 (765-810), 15:30-15:45 (930-945).
const term = (over = {}) => ({
  working_days: [0, 1, 2, 3, 4],
  day_start_min: 510,
  day_end_min: 1065,
  grid_minutes: 15,
  breaks: [
    { start_min: 630, end_min: 645, label: 'Short break 1' },
    { start_min: 765, end_min: 810, label: 'Lunch' },
    { start_min: 930, end_min: 945, label: 'Short break 2' },
  ],
  ...over,
});
const theory = { kind: 'theory', duration_min: 60 };
const lab = { kind: 'lab', duration_min: 120 };

const check = (over) => checkPlacement({ term: term(), subject: theory, weekday: 0, start_min: 510, ...over });

test('a plain valid placement returns end_min', () => {
  assert.deepEqual(check(), { ok: true, end_min: 570 });
  assert.deepEqual(check({ subject: lab, start_min: 645 }), { ok: true, end_min: 765 });
});

test('back-to-back sessions are fine: ending exactly at a break start', () => {
  assert.deepEqual(check({ start_min: 570 }), { ok: true, end_min: 630 });
});

test('starting exactly at a break end is fine', () => {
  assert.deepEqual(check({ start_min: 645 }), { ok: true, end_min: 705 });
  assert.deepEqual(check({ start_min: 810 }), { ok: true, end_min: 870 });
});

test('overlapping a break is rejected with a plain-English sentence', () => {
  const r = check({ start_min: 600 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'OVERLAPS_BREAK');
  assert.equal(r.message, 'Monday 10:00–11:00 overlaps the Short break 1 (10:30–10:45).');
  const r2 = check({ start_min: 630 });
  assert.equal(r2.reason, 'OVERLAPS_BREAK');
  assert.equal(r2.message, 'Monday 10:30–11:30 overlaps the Short break 1 (10:30–10:45).');
  assert.equal(check({ start_min: 750 }).reason, 'OVERLAPS_BREAK'); // 12:30-13:30 clips lunch
  assert.equal(check({ start_min: 780 }).reason, 'OVERLAPS_BREAK'); // starts inside lunch
});

test('a break strictly inside a long session is rejected', () => {
  const r = check({ subject: { kind: 'theory', duration_min: 240 }, start_min: 540 }); // 09:00-13:00
  assert.equal(r.reason, 'OVERLAPS_BREAK');
  assert.match(r.message, /Short break 1/);
});

test('a 120-minute lab crossing a break is rejected', () => {
  const r = check({ subject: lab, start_min: 570 }); // 09:30-11:30 crosses 10:30 break
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'OVERLAPS_BREAK');
  assert.equal(check({ subject: lab, start_min: 645 }).ok, true);
});

test('end exactly at day end is ok; one minute past is rejected', () => {
  assert.deepEqual(check({ start_min: 1005 }), { ok: true, end_min: 1065 });
  const r = check({ subject: { kind: 'theory', duration_min: 61 }, start_min: 1005 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'OUTSIDE_HOURS');
  assert.equal(r.message, 'Monday 16:45–17:46 runs past the end of the day at 17:45.');
  assert.equal(check({ start_min: 1020 }).reason, 'OUTSIDE_HOURS');
});

test('starting before the day start is OUTSIDE_HOURS', () => {
  const r = check({ start_min: 495 });
  assert.equal(r.reason, 'OUTSIDE_HOURS');
  assert.equal(r.message, 'Monday 08:15 is before the day starts at 08:30.');
  assert.equal(check({ start_min: 0 }).reason, 'OUTSIDE_HOURS');
});

test('starting at day start is fine', () => {
  assert.equal(check({ start_min: 510 }).ok, true);
});

test('not a working day', () => {
  const r = check({ weekday: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'NOT_WORKING_DAY');
  assert.equal(r.message, 'Saturday is not a working day for this term.');
  assert.equal(check({ weekday: 9 }).message, 'Day 9 is not a working day for this term.');
  assert.equal(check({ weekday: -1 }).reason, 'NOT_WORKING_DAY');
  assert.equal(check({ weekday: '1' }).reason, 'NOT_WORKING_DAY');
  assert.equal(check({ weekday: null }).reason, 'NOT_WORKING_DAY');
  assert.equal(check({ weekday: 1.5 }).reason, 'NOT_WORKING_DAY');
});

test('a Saturday term allows Saturday and refuses a dropped Wednesday', () => {
  const t = term({ working_days: [0, 1, 3, 4, 5] });
  assert.equal(checkPlacement({ term: t, subject: theory, weekday: 5, start_min: 510 }).ok, true);
  assert.equal(checkPlacement({ term: t, subject: theory, weekday: 2, start_min: 510 }).reason, 'NOT_WORKING_DAY');
});

test('off the 15-minute grid', () => {
  const r = check({ start_min: 515 });
  assert.equal(r.reason, 'OFF_GRID');
  assert.match(r.message, /08:35 is not on the 15-minute grid/);
  assert.equal(check({ start_min: 500 }).reason, 'OFF_GRID');
  assert.equal(check({ start_min: 540.5 }).reason, 'OFF_GRID');
  assert.equal(check({ start_min: null }).reason, 'OFF_GRID');
  assert.equal(check({ start_min: '540' }).reason, 'OFF_GRID');
  assert.equal(check({ start_min: NaN }).reason, 'OFF_GRID');
});

test('grid_minutes=30 with day_start 510: 525 is off grid although 525 % 15 == 0', () => {
  const t = term({ grid_minutes: 30 });
  const r = checkPlacement({ term: t, subject: theory, weekday: 0, start_min: 525 });
  assert.equal(525 % 15, 0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'OFF_GRID');
  assert.match(r.message, /30-minute grid/);
  assert.equal(checkPlacement({ term: t, subject: theory, weekday: 0, start_min: 540 }).ok, true);
  assert.equal(checkPlacement({ term: t, subject: theory, weekday: 0, start_min: 510 }).ok, true);
});

test('grid is measured from day_start_min', () => {
  const t = term({ grid_minutes: 30, day_start_min: 540 }); // 09:00 start
  assert.equal(checkPlacement({ term: t, subject: theory, weekday: 0, start_min: 540 }).ok, true);
  assert.equal(checkPlacement({ term: t, subject: theory, weekday: 0, start_min: 570 }).ok, true);
  assert.equal(checkPlacement({ term: t, subject: theory, weekday: 0, start_min: 555 }).reason, 'OFF_GRID');
});

test('checks run in order: day, grid, hours, breaks, room', () => {
  assert.equal(check({ weekday: 6, start_min: 515 }).reason, 'NOT_WORKING_DAY');
  assert.equal(check({ start_min: 5 }).reason, 'OFF_GRID');
  assert.equal(check({ start_min: 0 }).reason, 'OUTSIDE_HOURS');
  // breaks beat room
  assert.equal(
    check({ start_min: 630, room_id: 'x', poolRoomIds: new Set(['y']) }).reason,
    'OVERLAPS_BREAK',
  );
  // hours beat breaks (runs past day end, but also overlapping nothing)
  assert.equal(check({ start_min: 1050 }).reason, 'OUTSIDE_HOURS');
});

test('room pool is checked only when both room_id and poolRoomIds are given', () => {
  assert.equal(check({ room_id: 'r1', poolRoomIds: new Set(['r1', 'r2']) }).ok, true);
  assert.equal(check({ room_id: 'r1', poolRoomIds: ['r1'] }).ok, true);
  const r = check({ room_id: 'r3', poolRoomIds: new Set(['r1']) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ROOM_NOT_IN_POOL');
  assert.equal(r.message, "That room is not in this term's room pool.");
  assert.equal(check({ room_id: 'r3', poolRoomIds: [] }).reason, 'ROOM_NOT_IN_POOL');
  assert.equal(check({ room_id: 'r3' }).ok, true);
  assert.equal(check({ poolRoomIds: new Set(['r1']) }).ok, true);
  assert.equal(check({ room_id: null, poolRoomIds: new Set(['r1']) }).ok, true);
});

test('breaks without a label still give a readable message', () => {
  const t = term({ breaks: [{ start_min: 700, end_min: 720 }] });
  const r = checkPlacement({ term: t, subject: theory, weekday: 0, start_min: 690 });
  assert.equal(r.reason, 'OVERLAPS_BREAK');
  assert.equal(r.message, 'Monday 11:30–12:30 overlaps the break (11:40–12:00).');
});

test('malformed breaks are ignored', () => {
  const t = term({
    breaks: [null, 'x', 7, {}, { start_min: 'a', end_min: 700 }, { start_min: 700, end_min: 700 }, { start_min: 720, end_min: 700 }, { start_min: 780, end_min: 810, label: 'Lunch' }],
  });
  assert.equal(checkPlacement({ term: t, subject: theory, weekday: 0, start_min: 630 }).ok, true);
  assert.equal(checkPlacement({ term: t, subject: theory, weekday: 0, start_min: 780 }).reason, 'OVERLAPS_BREAK');
});

test('breaks given as numeric strings are honoured', () => {
  const t = term({ breaks: [{ start_min: '780', end_min: '810' }] });
  assert.equal(checkPlacement({ term: t, subject: theory, weekday: 0, start_min: 780 }).reason, 'OVERLAPS_BREAK');
});

test('missing breaks fall back to the default breaks; an empty list means no breaks', () => {
  const noKey = term();
  delete noKey.breaks;
  assert.equal(checkPlacement({ term: noKey, subject: theory, weekday: 0, start_min: 630 }).reason, 'OVERLAPS_BREAK');
  assert.equal(checkPlacement({ term: term({ breaks: [] }), subject: theory, weekday: 0, start_min: 630 }).ok, true);
  assert.equal(checkPlacement({ term: term({ breaks: 'nope' }), subject: theory, weekday: 0, start_min: 630 }).reason, 'OVERLAPS_BREAK');
});

test('missing term fields use defaults', () => {
  assert.deepEqual(checkPlacement({ term: {}, subject: theory, weekday: 0, start_min: 510 }), { ok: true, end_min: 570 });
  assert.equal(checkPlacement({ term: {}, subject: theory, weekday: 5, start_min: 510 }).reason, 'NOT_WORKING_DAY');
});

test('never throws on bad input', () => {
  for (const input of [undefined, null, {}, { term: null }, { term: 5, subject: 'x', weekday: 0, start_min: 510 }]) {
    const r = checkPlacement(input);
    assert.equal(typeof r.ok, 'boolean');
    if (!r.ok) {
      assert.equal(typeof r.reason, 'string');
      assert.equal(typeof r.message, 'string');
    }
  }
  const noDuration = checkPlacement({ term: term(), subject: {}, weekday: 0, start_min: 510 });
  assert.equal(noDuration.ok, false);
  assert.equal(noDuration.reason, 'OUTSIDE_HOURS');
  assert.equal(checkPlacement({ term: term(), subject: { duration_min: 0 }, weekday: 0, start_min: 510 }).ok, false);
  assert.equal(checkPlacement({ term: term(), subject: { duration_min: -60 }, weekday: 0, start_min: 510 }).ok, false);
});

test('gridStep = lcm(15, grid_minutes)', () => {
  assert.equal(gridStep(term()), 15);
  assert.equal(gridStep(term({ grid_minutes: 30 })), 30);
  assert.equal(gridStep(term({ grid_minutes: 45 })), 45);
  assert.equal(gridStep(term({ grid_minutes: 20 })), 60);
  assert.equal(gridStep(term({ grid_minutes: 10 })), 30);
  assert.equal(gridStep(term({ grid_minutes: 5 })), 15);
  assert.equal(gridStep({}), 15);
  assert.equal(gridStep(null), 15);
  assert.equal(gridStep(term({ grid_minutes: 0 })), 15);
  assert.equal(gridStep(term({ grid_minutes: 'abc' })), 15);
});

test('overlapsBreak is half-open and returns the first overlapping break', () => {
  const t = term();
  assert.equal(overlapsBreak(t, 570, 630), null);
  assert.equal(overlapsBreak(t, 645, 705), null);
  assert.equal(overlapsBreak(t, 570, 631).label, 'Short break 1');
  assert.equal(overlapsBreak(t, 644, 700).label, 'Short break 1');
  assert.equal(overlapsBreak(t, 600, 900).label, 'Short break 1'); // spans two, first one wins
  assert.equal(overlapsBreak(t, 700, 900).label, 'Lunch');
  assert.equal(overlapsBreak(null, 630, 640).label, 'Short break 1');
  assert.equal(overlapsBreak(t, NaN, 640), null);
  assert.equal(overlapsBreak(t, undefined, undefined), null);
});

test('overlapsBreak returns the earliest break even when breaks are unsorted', () => {
  const t = term({ breaks: [{ start_min: 765, end_min: 810, label: 'Lunch' }, { start_min: 630, end_min: 645, label: 'Early' }] });
  assert.equal(overlapsBreak(t, 600, 800).label, 'Early');
});
