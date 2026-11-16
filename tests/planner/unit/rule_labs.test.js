import test from 'node:test';
import assert from 'node:assert/strict';
import { mini, run, put, msgs, T } from './ruleKit.js';

function world({ labWeekly = 2, allowSecond = false } = {}) {
  const w = mini({
    rooms: [{ name: 'L1', lab: true, cap: 62 }, { name: 'L2', lab: true, cap: 62 }, { name: 'C1', cap: 70 }],
    faculty: ['A', 'B'],
    subjects: [
      { code: 'DSL', kind: 'lab', weekly: labWeekly },
      { code: 'OSL', kind: 'lab', weekly: 1 },
      { code: 'DS', kind: 'theory', weekly: 1 },
    ],
    divisions: [{ name: 'CSE-A', students: 60, sem: 3, batches: [['A1', 30], ['A2', 30]] }],
    offerings: [
      { div: 'CSE-A', code: 'DSL', faculty: 'A', batch: 'A1' },
      { div: 'CSE-A', code: 'DSL', faculty: 'A', batch: 'A2' },
      { div: 'CSE-A', code: 'OSL', faculty: 'B', batch: 'A1' },
      { div: 'CSE-A', code: 'OSL', faculty: 'B', batch: 'A2' },
      { div: 'CSE-A', code: 'DS', faculty: 'B' },
    ],
  });
  w.subjects.find((s) => s.code === 'DSL').allow_second_lab = allowSecond;
  return w;
}

test('lab_per_day: two lab sessions of one batch on one day fail; other days or other batches pass', () => {
  const w = world();
  put(w, 'CSE-A', 'DSL', 'A1', 1, 0, T.s0830, 'L1');
  put(w, 'CSE-A', 'OSL', 'A1', 1, 0, T.s1330, 'L1'); // same batch, same day
  put(w, 'CSE-A', 'DSL', 'A2', 1, 0, T.s0830, 'L2'); // other batch: its own day count is 1
  const issues = run('lab_per_day', w);
  assert.equal(issues.length, 1, msgs(issues).join('\n'));
  assert.equal(issues[0].severity, 'hard');
  assert.equal(issues[0].weekday, 0);
  assert.equal(issues[0].session_ids.length, 2);
  assert.match(issues[0].message, /Batch A1 of CSE-A \(Sem 3\) has 2 lab sessions on Monday \(DSL 08:30–10:30, OSL 13:30–15:30\); the limit is 1 per day\./);

  const ok = world(); // A1 on two different days, A2 twice on Monday
  put(ok, 'CSE-A', 'DSL', 'A1', 1, 0, T.s0830, 'L1');
  put(ok, 'CSE-A', 'OSL', 'A1', 1, 1, T.s0830, 'L1');
  put(ok, 'CSE-A', 'DSL', 'A2', 1, 0, T.s0830, 'L2');
  put(ok, 'CSE-A', 'OSL', 'A2', 1, 0, T.s1330, 'L2'); // batch A2 now has two labs on Monday
  assert.equal(run('lab_per_day', ok).length, 1);
  assert.deepEqual(run('lab_per_day', ok, { params: { max: 2 } }), [], 'params.max raises the limit');
});

test('lab_per_day: a whole-division lab session counts for every batch of its division', () => {
  const w = mini({
    rooms: [{ name: 'L1', lab: true, cap: 90 }],
    faculty: ['A', 'B'],
    subjects: [{ code: 'WL', kind: 'lab', weekly: 1 }, { code: 'DSL', kind: 'lab', weekly: 1 }],
    divisions: [{ name: 'CSE-A', students: 60, sem: 3, batches: [['A1', 30], ['A2', 30]] }],
    offerings: [{ div: 'CSE-A', code: 'DSL', faculty: 'A', batch: 'A1' }],
  });
  // a lab offering with no batch rows still expands per batch; use the whole-batch session of a manual clone
  const whole = w.divisions[0].batches.find((b) => b.is_whole);
  const extra = { ...w.sessions[0], id: 'ses-whole', batch_id: whole.id, batch_name: 'ALL', subject_code: 'WL' };
  w.sessions.push(extra);
  put(w, 'CSE-A', 'DSL', 'A1', 1, 0, T.s0830, 'L1');
  extra.weekday = 0; extra.start_min = T.s1330; extra.end_min = T.s1330 + 120; extra.room_id = w.rooms[0].room_id;
  const issues = run('lab_per_day', w);
  assert.equal(issues.length, 1, msgs(issues).join('\n'));
  assert.match(issues[0].message, /Batch A1 of CSE-A \(Sem 3\) has 2 lab sessions/);
});

test('lab_weekly: flags only surplus lab sessions beyond the weekly count; weekly 2 + allow_second_lab=false is a data issue, not flagged', () => {
  // weekly 2, second lab NOT allowed: the generator's own output (2 sessions per batch) must not be flagged
  const w = world({ labWeekly: 2, allowSecond: false });
  put(w, 'CSE-A', 'DSL', 'A1', 1, 0, T.s0830, 'L1');
  put(w, 'CSE-A', 'DSL', 'A1', 2, 2, T.s0830, 'L1');
  put(w, 'CSE-A', 'DSL', 'A2', 1, 1, T.s0830, 'L1');
  assert.deepEqual(run('lab_weekly', w), []);

  const allowed = world({ labWeekly: 2, allowSecond: true });
  put(allowed, 'CSE-A', 'DSL', 'A1', 1, 0, T.s0830, 'L1');
  put(allowed, 'CSE-A', 'DSL', 'A1', 2, 2, T.s0830, 'L1');
  assert.deepEqual(run('lab_weekly', allowed), []);

  // a surplus session (more sessions than the weekly count) is flagged whatever allow_second_lab says
  for (const allowSecond of [true, false]) {
    const surplus = world({ labWeekly: 1, allowSecond });
    put(surplus, 'CSE-A', 'DSL', 'A1', 1, 0, T.s0830, 'L1');
    const dup = { ...surplus.sessions.find((s) => s.weekday === 0), id: 'ses-extra', seq: 2, weekday: 3, start_min: T.s0830, end_min: T.s0830 + 120 };
    surplus.sessions.push(dup);
    const s = run('lab_weekly', surplus);
    assert.equal(s.length, 1, `allowSecond=${allowSecond}`);
    assert.equal(s[0].severity, 'hard');
    assert.match(s[0].message, /2 lab sessions placed for batch A1.*meets 1 time a week/);
  }
});

test('lab_weekly: unplaced labs and theory are not its business (all_placed reports missing ones)', () => {
  const w = world({ labWeekly: 2 });
  put(w, 'CSE-A', 'DSL', 'A1', 1, 0, T.s0830, 'L1');
  put(w, 'CSE-A', 'DS', 'ALL', 1, 0, T.s1330, 'L1');
  assert.deepEqual(run('lab_weekly', w), []);
});
