import test from 'node:test';
import assert from 'node:assert/strict';
import { run, put, theoryWorld, msgs, T } from './ruleKit.js';

const SLOTS = [T.s0830, T.s0930, T.s1045, T.s1145, T.s1330, T.s1430, T.s1545, T.s1645];

/** One teacher (A) teaching `n` DS sessions of CSE-A on `day`, in the first n standard slots. */
function loaded(n, { day = 0, weekly = 8, slots = SLOTS } = {}) {
  const w = theoryWorld({ weekly });
  for (let i = 0; i < n; i++) put(w, 'CSE-A', 'DS', 'ALL', i + 1, day, slots[i], 'C1');
  return w;
}

test('faculty_daily_load: more than default_max_hours in a day fails, exactly the limit passes', () => {
  const six = loaded(6);
  assert.deepEqual(run('faculty_daily_load', six), []);
  const eight = loaded(8);
  const issues = run('faculty_daily_load', eight);
  assert.equal(issues.length, 1, msgs(issues).join('\n'));
  assert.equal(issues[0].severity, 'soft');
  assert.equal(issues[0].weekday, 0);
  assert.equal(issues[0].faculty_id, eight.faculty[0].id);
  assert.equal(issues[0].session_ids.length, 8);
  assert.match(issues[0].message, /Prof A \(A\) teaches 8 h on Monday; the default limit is 6 h per day\./);
  assert.deepEqual(run('faculty_daily_load', eight, { params: { default_max_hours: 8 } }), [], 'param raises the limit');
});

test("faculty_daily_load: the teacher's own max_per_day (sessions) replaces the default hours", () => {
  const w = loaded(4);
  w.faculty[0].max_per_day = 3;
  const issues = run('faculty_daily_load', w);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /has 4 sessions on Monday; their limit is 3 per day/);
  w.faculty[0].max_per_day = 4;
  assert.deepEqual(run('faculty_daily_load', w), []);
  // an own limit of 8 sessions also overrides the 6 h default: 8 sessions on a day pass
  const big = loaded(8);
  big.faculty[0].max_per_day = 8;
  assert.deepEqual(run('faculty_daily_load', big), []);
});

test('faculty_daily_load: a 2 h lab counts its 2 hours (union of intervals, assist teachers included)', () => {
  const w = theoryWorld({ weekly: 8 });
  for (let i = 0; i < 4; i++) put(w, 'CSE-A', 'DS', 'ALL', i + 1, 0, SLOTS[i], 'C1'); // 4 h
  put(w, 'CSE-A', 'DS', 'ALL', 5, 0, T.s1330, 'C1'); // 5 h
  put(w, 'CSE-A', 'DS', 'ALL', 6, 0, T.s1430, 'C1'); // 6 h
  assert.deepEqual(run('faculty_daily_load', w), []);
  w.sessions.find((s) => s.seq === 6).end_min += 15; // 6 h 15 min
  assert.equal(run('faculty_daily_load', w).length, 1);
});

test('faculty_weekly_load: hours above max_per_week fail; teachers without a limit are skipped', () => {
  const w = theoryWorld({ weekly: 8 });
  for (let i = 0; i < 6; i++) put(w, 'CSE-A', 'DS', 'ALL', i + 1, i % 5, T.s0830, 'C1');
  assert.deepEqual(run('faculty_weekly_load', w), [], 'no limit set');
  w.faculty[0].max_per_week = 5;
  const issues = run('faculty_weekly_load', w);
  assert.equal(issues.length, 1, msgs(issues).join('\n'));
  assert.match(issues[0].message, /Prof A \(A\) teaches 6 h a week; their limit is 5 h\./);
  assert.equal(issues[0].weekday, null);
  assert.equal(issues[0].session_ids.length, 6);
  assert.equal(issues[0].id, `faculty_weekly_load::f:${w.faculty[0].id}`);
  w.faculty[0].max_per_week = 6;
  assert.deepEqual(run('faculty_weekly_load', w), []);
});

test('faculty_consecutive: a run over n hours fails (short breaks do not interrupt, lunch does)', () => {
  const run4 = loaded(4); // 08:30-10:30, 10:45-12:45: only the 15 min break between
  const issues = run('faculty_consecutive', run4);
  assert.equal(issues.length, 1, msgs(issues).join('\n'));
  assert.equal(issues[0].severity, 'soft');
  assert.match(issues[0].message, /Prof A \(A\) teaches 4 h in a row on Monday \(08:30–12:45\); the limit is 3 h\./);
  assert.equal(issues[0].session_ids.length, 4);
  assert.deepEqual(run('faculty_consecutive', run4, { params: { n: 4 } }), []);

  const lunch = loaded(4, { slots: [T.s1045, T.s1145, T.s1330, T.s1430] }); // lunch (45 min) splits 2 + 2
  assert.deepEqual(run('faculty_consecutive', lunch), []);
});

test('faculty_idle_gap: a gap longer than max_gap_minutes (breaks excluded) fails', () => {
  const small = loaded(2, { slots: [T.s0830, T.s1330] }); // free time 09:30..13:30 minus 15 + 45 break = 180 min
  assert.deepEqual(run('faculty_idle_gap', small), [], 'exactly 180 is allowed');
  const big = loaded(2, { slots: [T.s0830, T.s1430] }); // 240 min free
  const issues = run('faculty_idle_gap', big);
  assert.equal(issues.length, 1, msgs(issues).join('\n'));
  assert.equal(issues[0].session_ids.length, 2);
  assert.match(issues[0].message, /Prof A \(A\) waits 4 h between sessions on Monday \(09:30–14:30\)/);
  assert.deepEqual(run('faculty_idle_gap', big, { params: { max_gap_minutes: 240 } }), []);
});

test('faculty rules: another day is another day; severity follows the row; disabled rows give nothing', () => {
  const w = loaded(4);
  assert.ok(run('faculty_consecutive', w, { severity: 'hard' }).every((i) => i.severity === 'hard'));
  assert.deepEqual(run('faculty_consecutive', w, { enabled: false }), []);
  const spread = theoryWorld({ weekly: 8 });
  for (let i = 0; i < 4; i++) put(spread, 'CSE-A', 'DS', 'ALL', i + 1, i, T.s0830, 'C1');
  for (const k of ['faculty_daily_load', 'faculty_consecutive', 'faculty_idle_gap', 'faculty_weekly_load']) assert.deepEqual(run(k, spread), [], k);
});
