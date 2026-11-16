import test from 'node:test';
import assert from 'node:assert/strict';
import { mini, run, put, theoryWorld, msgs, T } from './ruleKit.js';

test('subject_spread: the same subject twice on a day fails (split or back to back) when it can be avoided', () => {
  const split = theoryWorld({ weekly: 4 });
  put(split, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1');
  put(split, 'CSE-A', 'DS', 'ALL', 2, 0, T.s1330, 'C1');
  put(split, 'CSE-A', 'DS', 'ALL', 3, 1, T.s0830, 'C1');
  const issues = run('subject_spread', split);
  assert.equal(issues.length, 1, msgs(issues).join('\n'));
  assert.equal(issues[0].severity, 'soft');
  assert.equal(issues[0].weekday, 0);
  assert.match(issues[0].message, /DS is scheduled 2 times on Monday for CSE-A \(Sem 3\) \(08:30, 13:30\); the limit is 1 per day\./);

  const b2b = theoryWorld({ weekly: 4 });
  put(b2b, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1');
  put(b2b, 'CSE-A', 'DS', 'ALL', 2, 0, T.s0930, 'C1');
  assert.equal(run('subject_spread', b2b).length, 1, 'weekly 4 <= 5 days: not unavoidable');
  assert.deepEqual(run('subject_spread', b2b, { params: { max_per_day: 2 } }), []);
});

test('subject_spread: back-to-back repeats are accepted when the weekly count exceeds the working days', () => {
  const w = theoryWorld({ weekly: 6 });
  put(w, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1');
  put(w, 'CSE-A', 'DS', 'ALL', 2, 0, T.s0930, 'C1');
  assert.deepEqual(run('subject_spread', w), []);
  put(w, 'CSE-A', 'DS', 'ALL', 3, 1, T.s0830, 'C1');
  put(w, 'CSE-A', 'DS', 'ALL', 4, 1, T.s1330, 'C1'); // split on a day: still flagged
  assert.equal(run('subject_spread', w).length, 1);
});

function twoSubjects(extra = {}) {
  return mini({
    rooms: [{ name: 'C1', cap: 70 }, { name: 'C2', cap: 70 }],
    faculty: ['A', 'B'],
    subjects: [{ code: 'DS', kind: 'theory', weekly: 1 }, { code: 'OS', kind: 'theory', weekly: 1 }],
    divisions: [{ name: 'CSE-A', students: 60, sem: 3, home: 'C1' }],
    offerings: [{ div: 'CSE-A', code: 'DS', faculty: 'A' }, { div: 'CSE-A', code: 'OS', faculty: 'B' }],
    ...extra,
  });
}

test('room_change: consecutive theory sessions in different rooms need a break between them', () => {
  const w = twoSubjects();
  put(w, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1');
  put(w, 'CSE-A', 'OS', 'ALL', 1, 0, T.s0930, 'C2'); // back to back, other room
  const issues = run('room_change', w);
  assert.equal(issues.length, 1, msgs(issues).join('\n'));
  assert.equal(issues[0].severity, 'soft');
  assert.match(issues[0].message, /CSE-A \(Sem 3\) moves from room C1 \(DS, 08:30–09:30\) to room C2 \(OS, 09:30–10:30\) on Monday with no break in between\./);

  const same = twoSubjects();
  put(same, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1');
  put(same, 'CSE-A', 'OS', 'ALL', 1, 0, T.s0930, 'C1');
  assert.deepEqual(run('room_change', same), [], 'same room');

  const gap = twoSubjects();
  put(gap, 'CSE-A', 'DS', 'ALL', 1, 0, 570, 'C1'); // ends 10:30
  put(gap, 'CSE-A', 'OS', 'ALL', 1, 0, T.s1045, 'C2'); // starts 10:45 after the short break
  assert.deepEqual(run('room_change', gap), [], 'a break between them is enough in any_break mode');
  assert.equal(run('room_change', gap, { params: { min_break_minutes: 30 } }).length, 1, 'a 15 minute break is too short for min_break_minutes 30');
});

test('room_change: lunch_only needs a real break (lunch) between the two sessions', () => {
  const short = twoSubjects();
  put(short, 'CSE-A', 'DS', 'ALL', 1, 0, 570, 'C1');
  put(short, 'CSE-A', 'OS', 'ALL', 1, 0, T.s1045, 'C2');
  assert.equal(run('room_change', short, { params: { mode: 'lunch_only' } }).length, 1);

  const lunch = twoSubjects();
  put(lunch, 'CSE-A', 'DS', 'ALL', 1, 0, T.s1145, 'C1'); // ends 12:45, lunch 12:45-13:30
  put(lunch, 'CSE-A', 'OS', 'ALL', 1, 0, T.s1330, 'C2');
  assert.deepEqual(run('room_change', lunch, { params: { mode: 'lunch_only' } }), []);
});

test('room_change: labs are ignored (going to a lab room is not a room change)', () => {
  const w = mini({
    rooms: [{ name: 'C1', cap: 70 }, { name: 'L1', lab: true, cap: 62 }],
    faculty: ['A', 'B'],
    subjects: [{ code: 'DS', kind: 'theory', weekly: 1 }, { code: 'DSL', kind: 'lab', weekly: 1 }],
    divisions: [{ name: 'CSE-A', students: 60, sem: 3, batches: [['A1', 30], ['A2', 30]] }],
    offerings: [{ div: 'CSE-A', code: 'DS', faculty: 'A' }, { div: 'CSE-A', code: 'DSL', faculty: 'B', batch: 'A1' }, { div: 'CSE-A', code: 'DSL', faculty: 'B', batch: 'A2' }],
  });
  put(w, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1');
  put(w, 'CSE-A', 'DSL', 'A1', 1, 0, T.s0930, 'L1');
  assert.deepEqual(run('room_change', w), []);
});

test('time_of_day: only late theory starts are flagged (early starts are not diagnosed); labs are ignored', () => {
  const w = mini({
    rooms: [{ name: 'C1', cap: 70 }, { name: 'L1', lab: true, cap: 62 }],
    faculty: ['A', 'B'],
    subjects: [{ code: 'DS', kind: 'theory', weekly: 4 }, { code: 'DSL', kind: 'lab', weekly: 1 }],
    divisions: [{ name: 'CSE-A', students: 60, sem: 3, batches: [['A1', 30]] }],
    offerings: [{ div: 'CSE-A', code: 'DS', faculty: 'A' }, { div: 'CSE-A', code: 'DSL', faculty: 'B', batch: 'A1' }],
  });
  put(w, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1'); // before 10:45
  put(w, 'CSE-A', 'DS', 'ALL', 2, 1, T.s1045, 'C1'); // core
  put(w, 'CSE-A', 'DS', 'ALL', 3, 2, T.s1430, 'C1'); // 14:30-15:30: core (ends exactly at core_end)
  put(w, 'CSE-A', 'DS', 'ALL', 4, 3, T.s1545, 'C1'); // late
  put(w, 'CSE-A', 'DSL', 'A1', 1, 4, T.s0830, 'L1'); // lab at 08:30: ignored
  const issues = run('time_of_day', w);
  assert.equal(issues.length, 1, msgs(issues).join('\n'));
  assert.equal(issues.find((i) => i.weekday === 0), undefined, 'an 08:30 start is not diagnosed');
  assert.match(issues.find((i) => i.weekday === 3).message, /starts late, at 15:45 \(late starts begin at 15:45\)/);
  const shifted = run('time_of_day', w, { params: { late_start: 1065 } });
  assert.deepEqual(shifted, [], 'params move the window');
});
