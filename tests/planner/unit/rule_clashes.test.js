import test from 'node:test';
import assert from 'node:assert/strict';
import { mini, run, put, msgs, T } from './ruleKit.js';

/** Two divisions (A: batches A1-A3 of 20, B: batches B1-B2 of 30), classrooms C1/C2, labs L1/L2 (capacity 62). */
function world(over = {}) {
  return mini({
    rooms: [{ name: 'C1', cap: 70 }, { name: 'C2', cap: 70 }, { name: 'L1', lab: true, cap: 62 }, { name: 'L2', lab: true, cap: 62 }],
    faculty: ['A', 'B', 'C', 'D', 'E', 'F'],
    subjects: [
      { code: 'DS', kind: 'theory', weekly: 1 },
      { code: 'OS', kind: 'theory', weekly: 1 },
      { code: 'DSL', kind: 'lab', weekly: 1 },
    ],
    divisions: [
      { name: 'CSE-A', students: 60, sem: 3, batches: [['A1', 20], ['A2', 20], ['A3', 20]] },
      { name: 'CSE-B', students: 60, sem: 3, batches: [['B1', 30], ['B2', 30]] },
    ],
    offerings: [
      { div: 'CSE-A', code: 'DS', faculty: 'A' },
      { div: 'CSE-A', code: 'OS', faculty: 'B' },
      { div: 'CSE-B', code: 'DS', faculty: 'A' },
      { div: 'CSE-B', code: 'OS', faculty: 'B' },
      { div: 'CSE-A', code: 'DSL', faculty: 'C', batch: 'A1' },
      { div: 'CSE-A', code: 'DSL', faculty: 'D', batch: 'A2' },
      { div: 'CSE-A', code: 'DSL', faculty: 'E', batch: 'A3' },
      { div: 'CSE-B', code: 'DSL', faculty: 'F', batch: 'B1' },
      { div: 'CSE-B', code: 'DSL', faculty: 'C', batch: 'B2' },
    ],
    ...over,
  });
}

test('faculty_clash: one teacher in two sessions at once (names, not ids); back-to-back is fine', () => {
  const w = world();
  put(w, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1');
  put(w, 'CSE-B', 'DS', 'ALL', 1, 0, T.s0830, 'C2');
  const issues = run('faculty_clash', w);
  assert.equal(issues.length, 1, msgs(issues).join('\n'));
  const [i] = issues;
  assert.equal(i.severity, 'blocking');
  assert.equal(i.rule_key, 'faculty_clash');
  assert.equal(i.weekday, 0);
  assert.equal(i.faculty_id, w.faculty[0].id);
  assert.equal(i.session_ids.length, 2);
  assert.equal(i.division_id, null, 'two divisions involved');
  assert.match(i.message, /Prof A \(A\) is teaching both DS for CSE-A \(Sem 3\) \(08:30–09:30\) and DS for CSE-B \(Sem 3\) \(08:30–09:30\) on Monday/);
  assert.ok(i.fix_hint);

  const ok = world();
  put(ok, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1');
  put(ok, 'CSE-B', 'DS', 'ALL', 1, 0, T.s0930, 'C2');
  assert.deepEqual(run('faculty_clash', ok), []);
  const other = world();
  put(other, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1');
  put(other, 'CSE-B', 'DS', 'ALL', 1, 1, T.s0830, 'C2'); // another day
  assert.deepEqual(run('faculty_clash', other), []);
});

test('batch_clash: a whole-division session clashes with any batch session; different batches do not; same batch does', () => {
  const w = world();
  put(w, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1');
  put(w, 'CSE-A', 'DSL', 'A1', 1, 0, T.s0830, 'L1'); // whole lecture vs batch lab
  put(w, 'CSE-A', 'DSL', 'A2', 1, 1, T.s0830, 'L1');
  put(w, 'CSE-A', 'DSL', 'A3', 1, 1, T.s0830, 'L2'); // A2 and A3 in parallel: fine
  const issues = run('batch_clash', w);
  assert.equal(issues.length, 1, msgs(issues).join('\n'));
  assert.equal(issues[0].severity, 'blocking');
  assert.equal(issues[0].division_id, w.divisions[0].id);
  assert.match(issues[0].message, /all of CSE-A \(Sem 3\) has DS .* and DSL batch A1 .* at the same time on Monday/);

  const same = world({ subjects: [{ code: 'DS', kind: 'theory', weekly: 1 }, { code: 'OS', kind: 'theory', weekly: 1 }, { code: 'DSL', kind: 'lab', weekly: 2 }] });
  put(same, 'CSE-A', 'DSL', 'A1', 1, 0, T.s0830, 'L1');
  put(same, 'CSE-A', 'DSL', 'A1', 2, 0, T.s0930, 'L2'); // overlaps (08:30-10:30 vs 09:30-11:30), same batch
  assert.equal(run('batch_clash', same).length, 1);

  const none = world();
  put(none, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1');
  put(none, 'CSE-B', 'DS', 'ALL', 1, 0, T.s0830, 'C2'); // other division
  put(none, 'CSE-A', 'OS', 'ALL', 1, 0, T.s0930, 'C1'); // back to back
  assert.deepEqual(run('batch_clash', none), []);
});

test('room_clash: exclusive room used twice; separate rooms are fine', () => {
  const w = world();
  put(w, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1');
  put(w, 'CSE-B', 'OS', 'ALL', 1, 0, T.s0830, 'C1');
  const issues = run('room_clash', w);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /Room C1 is used by DS for CSE-A \(Sem 3\) \(08:30–09:30\) and by OS for CSE-B \(Sem 3\) \(08:30–09:30\) on Monday/);
  const ok = world();
  put(ok, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1');
  put(ok, 'CSE-B', 'OS', 'ALL', 1, 0, T.s0830, 'C2');
  assert.deepEqual(run('room_clash', ok), []);
});

test('room_clash: a shared lab holds several batches up to its capacity (8.7), not beyond', () => {
  const fits = world();
  put(fits, 'CSE-A', 'DSL', 'A1', 1, 0, T.s0830, 'L1'); // 20
  put(fits, 'CSE-A', 'DSL', 'A2', 1, 0, T.s0830, 'L1'); // 20
  put(fits, 'CSE-A', 'DSL', 'A3', 1, 0, T.s0830, 'L1'); // 20 -> 60 <= 62
  assert.deepEqual(run('room_clash', fits), []);

  const over = world();
  put(over, 'CSE-A', 'DSL', 'A1', 1, 0, T.s0830, 'L1'); // 20
  put(over, 'CSE-A', 'DSL', 'A2', 1, 0, T.s0830, 'L1'); // 20
  put(over, 'CSE-B', 'DSL', 'B1', 1, 0, T.s0830, 'L1'); // 30 -> 70 > 62
  const issues = run('room_clash', over);
  assert.equal(issues.length, 1, msgs(issues).join('\n'));
  assert.equal(issues[0].session_ids.length, 3);
  assert.match(issues[0].message, /Room L1 \(capacity 62\) would hold 70 students on Monday 08:30–10:30/);
});

test('room_clash: only the over-full part of a staggered shared lab is flagged; an exclusive theory session in a lab clashes', () => {
  const w = world();
  put(w, 'CSE-A', 'DSL', 'A1', 1, 0, 510, 'L1'); // 08:30-10:30, 20
  put(w, 'CSE-B', 'DSL', 'B1', 1, 0, 570, 'L1'); // 09:30-11:30, 30 -> 50
  put(w, 'CSE-B', 'DSL', 'B2', 1, 0, 645, 'L1'); // 10:45-12:45, 30: with B1 (until 11:30) = 60, with A1 gone: fine
  assert.deepEqual(run('room_clash', w), []);
  const x = world();
  put(x, 'CSE-A', 'DSL', 'A1', 1, 0, T.s0830, 'L1');
  put(x, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0930, 'L1'); // theory is exclusive, even in a lab room
  assert.equal(run('room_clash', x).length, 1);
});

test('clash rules ignore unplaced sessions; blocking rules cannot be switched off', () => {
  const w = world();
  put(w, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1');
  assert.deepEqual(run('room_clash', w), []);
  put(w, 'CSE-B', 'OS', 'ALL', 1, 0, T.s0830, 'C1');
  assert.equal(run('room_clash', w).length, 1);
  assert.equal(run('room_clash', w, { enabled: false, severity: 'soft' }).length, 1, 'a blocking rule always runs, always as blocking');
  assert.equal(run('room_clash', w, { enabled: false, severity: 'soft' })[0].severity, 'blocking');
});
