import test from 'node:test';
import assert from 'node:assert/strict';
import { run, put, theoryWorld, msgs, sessionOf, T } from './ruleKit.js';
import { checkPlacement } from '../../../services/planner/domain/placement.js';

const FOUR = ['working_hours', 'break_overlap', 'grid', 'duration'];
const all = (w) => Object.fromEntries(FOUR.map((k) => [k, run(k, w)]));

test('placement rules: a valid placement has no issue under any of the four keys', () => {
  const w = theoryWorld();
  put(w, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1');
  for (const [k, issues] of Object.entries(all(w))) assert.deepEqual(issues, [], k);
});

test('working_hours: non-working day, before the day, past the day end', () => {
  const w = theoryWorld();
  put(w, 'CSE-A', 'DS', 'ALL', 1, 5, T.s0830, 'C1'); // Saturday
  put(w, 'CSE-A', 'DS', 'ALL', 2, 0, 480, 'C1'); // 08:00, before 08:30
  put(w, 'CSE-A', 'DS', 'ALL', 3, 1, 1020, 'C1'); // 17:00-18:00, past 17:45
  put(w, 'CSE-A', 'DS', 'ALL', 4, 2, T.s0830, 'C1'); // fine
  const issues = run('working_hours', w);
  assert.equal(issues.length, 3, msgs(issues).join('\n'));
  assert.ok(issues.every((i) => i.severity === 'blocking' && i.rule_key === 'working_hours' && i.session_ids.length === 1));
  assert.match(issues.find((i) => i.weekday === 5).message, /Saturday, which is not a working day/);
  assert.match(issues.find((i) => i.weekday === 0).message, /outside the college day \(08:30–17:45\)/);
});

test('break_overlap: names the break; back-to-back with a break edge is fine', () => {
  const w = theoryWorld();
  put(w, 'CSE-A', 'DS', 'ALL', 1, 0, 600, 'C1'); // 10:00-11:00 overlaps Short break 1 10:30-10:45
  put(w, 'CSE-A', 'DS', 'ALL', 2, 1, 705, 'C1'); // 11:45-12:45 ends exactly at lunch start
  put(w, 'CSE-A', 'DS', 'ALL', 3, 2, 645, 'C1'); // starts exactly at the break end
  const issues = run('break_overlap', w);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /overlaps the Short break 1 \(10:30–10:45\)/);
  assert.match(issues[0].message, /DS for CSE-A \(Sem 3\) on Monday 10:00–11:00/);
});

test('grid: off the quarter hour, or off the term grid', () => {
  const w = theoryWorld();
  put(w, 'CSE-A', 'DS', 'ALL', 1, 0, 512, 'C1');
  put(w, 'CSE-A', 'DS', 'ALL', 2, 1, 525, 'C1'); // on the quarter hour, on the 15-min grid: fine
  const issues = run('grid', w);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /starts at 08:32/);
  const w2 = theoryWorld();
  w2.term.grid_minutes = 30;
  put(w2, 'CSE-A', 'DS', 'ALL', 1, 0, 525, 'C1'); // 08:45: quarter hour but not on the 30-minute grid
  put(w2, 'CSE-A', 'DS', 'ALL', 2, 1, 540, 'C1');
  const g2 = run('grid', w2);
  assert.equal(g2.length, 1);
  assert.match(g2[0].message, /30-minute grid/);
});

test('duration: placed length differs from the subject duration', () => {
  const w = theoryWorld();
  const s = put(w, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1');
  s.end_min = s.start_min + 45;
  put(w, 'CSE-A', 'DS', 'ALL', 2, 1, T.s0830, 'C1');
  const issues = run('duration', w);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /placed for 45 min .* lasts 1 h/);
});

test('each condition is judged independently (a session can break two keys)', () => {
  const w = theoryWorld();
  put(w, 'CSE-A', 'DS', 'ALL', 1, 5, 600, 'C1'); // Saturday AND over the break AND... on grid
  const r = all(w);
  assert.equal(r.working_hours.length, 1);
  assert.equal(r.break_overlap.length, 1);
  assert.equal(r.grid.length, 0);
});

test('agrees with domain checkPlacement over a sweep of days and start times', () => {
  const w = theoryWorld({ weekly: 1 });
  const s = sessionOf(w, 'CSE-A', 'DS', 'ALL', 1);
  const room = w.rooms[0].room_id;
  const pool = new Set(w.rooms.map((r) => r.room_id));
  let checked = 0;
  for (let day = 0; day <= 6; day++) {
    for (let start = 470; start <= 1100; start += 5) {
      s.weekday = day; s.start_min = start; s.end_min = start + 60; s.room_id = room;
      const domainOk = checkPlacement({ term: w.term, subject: { duration_min: 60 }, weekday: day, start_min: start, room_id: room, poolRoomIds: pool }).ok;
      const n = FOUR.reduce((t, k) => t + run(k, w).length, 0);
      assert.equal(n === 0, domainOk, `day ${day} start ${start}: domain ok=${domainOk}, rule issues=${n}`);
      checked++;
    }
  }
  assert.ok(checked > 800);
});

test('an unplaced session never raises placement issues', () => {
  const w = theoryWorld();
  for (const k of FOUR) assert.deepEqual(run(k, w), [], k);
});
