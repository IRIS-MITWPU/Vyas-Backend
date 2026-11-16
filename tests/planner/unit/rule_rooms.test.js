import test from 'node:test';
import assert from 'node:assert/strict';
import { mini, run, put, msgs, T } from './ruleKit.js';

function world({ classCap = 70, labCap = 62 } = {}) {
  return mini({
    rooms: [{ name: 'C1', cap: classCap }, { name: 'L1', lab: true, cap: labCap }, { name: 'L0', lab: true, cap: null }],
    faculty: ['A', 'B'],
    subjects: [
      { code: 'DS', kind: 'theory', weekly: 3 },
      { code: 'OS', kind: 'theory', weekly: 2 },
      { code: 'DSL', kind: 'lab', weekly: 1 },
    ],
    divisions: [{ name: 'CSE-A', students: 60, sem: 3, batches: [['A1', 30], ['A2', 30]] }],
    offerings: [
      { div: 'CSE-A', code: 'DS', faculty: 'A' },
      { div: 'CSE-A', code: 'OS', faculty: 'A' },
      { div: 'CSE-A', code: 'DSL', faculty: 'B', batch: 'A1' },
      { div: 'CSE-A', code: 'DSL', faculty: 'B', batch: 'A2' },
    ],
  });
}

test('room_type: a lab in a classroom, theory in a lab room, a room outside the pool, no room', () => {
  const w = world();
  put(w, 'CSE-A', 'DSL', 'A1', 1, 0, T.s0830, 'C1'); // lab in a classroom
  put(w, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0930, 'L1'); // theory in a lab room
  put(w, 'CSE-A', 'DS', 'ALL', 2, 1, T.s0830, 'C1'); // fine
  put(w, 'CSE-A', 'DSL', 'A2', 1, 1, T.s1330, 'L1'); // fine
  const ghost = put(w, 'CSE-A', 'OS', 'ALL', 1, 2, T.s0830, 'C1');
  ghost.room_id = 'room-not-in-pool';
  const none = put(w, 'CSE-A', 'OS', 'ALL', 2, 2, T.s0930, 'C1');
  none.room_id = null;
  const issues = run('room_type', w);
  assert.equal(issues.length, 4, msgs(issues).join('\n'));
  assert.ok(issues.every((i) => i.severity === 'hard' && i.rule_key === 'room_type'));
  assert.match(issues.find((i) => /DSL batch A1/.test(i.message)).message, /is a lab but is placed in C1, which is not a lab room/);
  assert.match(issues.find((i) => /theory session/.test(i.message)).message, /lab room L1/);
  assert.ok(issues.some((i) => /not in this term's room pool/.test(i.message)));
  assert.ok(issues.some((i) => /has no room/.test(i.message)));
  // the severity follows the rule row
  assert.ok(run('room_type', w, { severity: 'soft' }).every((i) => i.severity === 'soft'));
});

test('room_capacity: exclusive and shared rooms compare a session own students; unknown capacity is not flagged', () => {
  const w = world({ classCap: 50 });
  put(w, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1'); // 60 students in a room for 50
  put(w, 'CSE-A', 'DSL', 'A1', 1, 0, T.s1330, 'L1'); // 30 in a lab for 62: fine
  put(w, 'CSE-A', 'DSL', 'A2', 1, 0, T.s1330, 'L0'); // unknown capacity: not flagged
  const issues = run('room_capacity', w);
  assert.equal(issues.length, 1, msgs(issues).join('\n'));
  assert.match(issues[0].message, /Room C1 holds 50 but CSE-A \(Sem 3\) has 60 students for DS on Monday 08:30–09:30/);
  assert.equal(issues[0].severity, 'hard');

  const small = world({ labCap: 25 });
  put(small, 'CSE-A', 'DSL', 'A1', 1, 0, T.s0830, 'L1'); // 30 students, lab of 25 (shared lab)
  const s = run('room_capacity', small);
  assert.equal(s.length, 1);
  assert.match(s[0].message, /CSE-A \(Sem 3\) batch A1 has 30 students/);

  const ok = world();
  put(ok, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1');
  assert.deepEqual(run('room_capacity', ok), []);
});

test('room_capacity: an over-full SHARED lab is reported once, under room_clash, not here', () => {
  const w = world({ labCap: 40 });
  put(w, 'CSE-A', 'DSL', 'A1', 1, 0, T.s0830, 'L1');
  put(w, 'CSE-A', 'DSL', 'A2', 1, 0, T.s0830, 'L1'); // 30 + 30 = 60 > 40, each alone fits
  assert.deepEqual(run('room_capacity', w), []);
  assert.equal(run('room_clash', w).length, 1);
});

test('all_placed: one issue per division + subject, listing the unplaced sessions', () => {
  const w = world();
  put(w, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1'); // 1 of 3 DS placed
  // OS: none placed (2 sessions); DSL: both batches unplaced
  const issues = run('all_placed', w);
  assert.equal(issues.length, 3, msgs(issues).join('\n'));
  const ds = issues.find((i) => / DS /.test(i.message));
  assert.equal(ds.session_ids.length, 2);
  assert.match(ds.message, /^CSE-A \(Sem 3\): 2 of 3 DS sessions are not placed\.$/);
  const lab = issues.find((i) => /DSL/.test(i.message));
  assert.equal(lab.session_ids.length, 2);
  assert.match(lab.message, /2 of 2 DSL sessions are not placed \(batch A1 x1, batch A2 x1\)/);
  assert.ok(issues.every((i) => i.severity === 'hard' && i.division_id === w.divisions[0].id && i.weekday === null));
  assert.equal(new Set(issues.map((i) => i.id)).size, 3);

  // placing more sessions keeps the issue id of the remaining ones (stable while the admin works)
  put(w, 'CSE-A', 'DS', 'ALL', 2, 1, T.s0830, 'C1');
  const after = run('all_placed', w).find((i) => / DS /.test(i.message));
  assert.equal(after.id, ds.id);
  assert.equal(after.session_ids.length, 1);
  assert.match(after.message, /1 of 3 DS sessions is not placed/);
});

test('all_placed: nothing to report when everything is placed', () => {
  const w = world();
  let t = 0;
  for (const s of w.sessions) {
    s.weekday = Math.floor(t / 8) % 5;
    s.start_min = [510, 570, 645, 705, 810, 870, 945, 1005][t % 8];
    s.end_min = s.start_min + s.duration_min;
    s.room_id = w.rooms[0].room_id;
    t++;
  }
  assert.deepEqual(run('all_placed', w), []);
});
