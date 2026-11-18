import test from 'node:test';
import assert from 'node:assert/strict';
import { mini, run, put, theoryWorld, msgs, T } from './ruleKit.js';

const SLOTS = [T.s0830, T.s0930, T.s1045, T.s1145, T.s1330, T.s1430, T.s1545, T.s1645];

function loaded(slotList, { day = 0, weekly = 8 } = {}) {
  const w = theoryWorld({ weekly });
  slotList.forEach((s, i) => put(w, 'CSE-A', 'DS', 'ALL', i + 1, day, s, 'C1'));
  return w;
}

test('student_consecutive: a division run longer than n hours fails; lunch splits it', () => {
  const w = loaded(SLOTS.slice(0, 4));
  const issues = run('student_consecutive', w);
  assert.equal(issues.length, 1, msgs(issues).join('\n'));
  assert.equal(issues[0].severity, 'soft');
  assert.equal(issues[0].division_id, w.divisions[0].id);
  assert.match(issues[0].message, /CSE-A \(Sem 3\) has 4 h of teaching in a row on Monday \(08:30–12:45\); the limit is 3 h\./);
  assert.deepEqual(run('student_consecutive', w, { params: { n: 4 } }), []);
  assert.deepEqual(run('student_consecutive', loaded([T.s1045, T.s1145, T.s1330, T.s1430])), []);
});

test('student_consecutive: parallel batch labs count once (union of the batches)', () => {
  const w = mini({
    rooms: [{ name: 'L1', lab: true, cap: 90 }, { name: 'C1', cap: 70 }],
    faculty: ['A', 'B', 'C', 'D'],
    subjects: [{ code: 'DSL', kind: 'lab', weekly: 1 }, { code: 'DS', kind: 'theory', weekly: 3 }],
    divisions: [{ name: 'CSE-A', students: 60, sem: 3, batches: [['A1', 30], ['A2', 30]] }],
    offerings: [
      { div: 'CSE-A', code: 'DSL', faculty: 'A', batch: 'A1' },
      { div: 'CSE-A', code: 'DSL', faculty: 'B', batch: 'A2' },
      { div: 'CSE-A', code: 'DS', faculty: 'C' },
    ],
  });
  put(w, 'CSE-A', 'DSL', 'A1', 1, 0, T.s0830, 'L1');
  put(w, 'CSE-A', 'DSL', 'A2', 1, 0, T.s0830, 'L1'); // parallel: still 2 h
  put(w, 'CSE-A', 'DS', 'ALL', 1, 0, T.s1045, 'C1'); // 3 h in total, 08:30-11:45
  assert.deepEqual(run('student_consecutive', w), []);
  put(w, 'CSE-A', 'DS', 'ALL', 2, 0, T.s1145, 'C1'); // 4 h
  assert.equal(run('student_consecutive', w).length, 1);
});

test('student_idle_gap: free time between first and last session of a day, breaks excluded', () => {
  const P = { params: { max_gap_minutes: 60 } };
  const ok = loaded([T.s0830, T.s1045]); // 09:30..10:45 = 75 min minus the 15 min break = 60: allowed
  assert.deepEqual(run('student_idle_gap', ok, P), []);
  const bad = loaded([T.s0830, T.s1145]); // 09:30..11:45 = 135 - 15 = 120 min
  const issues = run('student_idle_gap', bad, P);
  assert.equal(issues.length, 1, msgs(issues).join('\n'));
  assert.match(issues[0].message, /CSE-A \(Sem 3\) has 2 h of free time between its first and last session on Monday \(09:30–11:45\); the limit is 1 h\./);
  assert.deepEqual(run('student_idle_gap', bad, { params: { max_gap_minutes: 120 } }), []);
  // a single session, or no free time, has no idle time
  assert.deepEqual(run('student_idle_gap', loaded([T.s0830]), P), []);
  assert.deepEqual(run('student_idle_gap', loaded([T.s0830, T.s0930, T.s1045]), P), []);
});

test('student_idle_gap: the default is hard with a 0 minute limit, so even the 60 minute gap is an issue', () => {
  const issues = run('student_idle_gap', loaded([T.s0830, T.s1045]));
  assert.equal(issues.length, 1, msgs(issues).join('\n'));
  assert.equal(issues[0].severity, 'hard');
  assert.deepEqual(run('student_idle_gap', loaded([T.s0830, T.s0930, T.s1045])), [], 'no free time (only the break) is fine');
});

test('division_daily_hours: teaching hours above max_hours on one day', () => {
  assert.deepEqual(run('division_daily_hours', loaded(SLOTS.slice(0, 6))), []);
  const w = loaded(SLOTS.slice(0, 7));
  const issues = run('division_daily_hours', w);
  assert.equal(issues.length, 1, msgs(issues).join('\n'));
  assert.match(issues[0].message, /CSE-A \(Sem 3\) has 7 h of teaching on Monday; the limit is 6 h per day\./);
  assert.equal(issues[0].session_ids.length, 7);
  assert.deepEqual(run('division_daily_hours', w, { params: { max_hours: 7 } }), []);
});

test('day_balance: busiest minus lightest working day above the limit (an empty working day counts as 0 h)', () => {
  const lopsided = loaded(SLOTS.slice(0, 5)); // 5 h on Monday, 0 h on the other four working days
  const issues = run('day_balance', lopsided);
  assert.equal(issues.length, 1, msgs(issues).join('\n'));
  assert.equal(issues[0].weekday, null);
  assert.equal(issues[0].division_id, lopsided.divisions[0].id);
  assert.match(issues[0].message, /CSE-A \(Sem 3\) has 5 h on Monday but only 0 h on Tuesday: 5 h apart, the limit is 3 h\./);
  assert.equal(issues[0].id, `day_balance::d:${lopsided.divisions[0].id}`);

  const even = theoryWorld({ weekly: 5 });
  for (let d = 0; d < 5; d++) put(even, 'CSE-A', 'DS', 'ALL', d + 1, d, T.s0830, 'C1');
  assert.deepEqual(run('day_balance', even), []);
  assert.deepEqual(run('day_balance', lopsided, { params: { max_spread_hours: 5 } }), []);
  assert.deepEqual(run('day_balance', theoryWorld()), [], 'a division without placed sessions is skipped');
});
