import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedSessions, planSessionSync } from '../../../services/planner/domain/sessionSync.js';
import { baseState, clone, makeBatches } from '../fixtures/stateBuilder.js';

/** Applies a plan to an existing list, the way the API would. */
function apply(existing, plan) {
  let n = 1000;
  const kept = existing.filter((e) => !plan.toDeleteIds.includes(e.id));
  const added = plan.toCreate.map((c) => ({ id: `new-${n++}`, offering_id: c.offering_id, batch_id: c.batch_id, seq: c.seq, placed: false }));
  return [...kept, ...added];
}

test('expectedSessions: whole-batch theory + per-batch lab', () => {
  const exp = expectedSessions(baseState());
  const theory = exp.filter((e) => e.offering_id === 'o-ds');
  const lab = exp.filter((e) => e.offering_id === 'o-dsl');
  assert.equal(theory.length, 4);
  assert.ok(theory.every((e) => e.batch_id === 'd1-ALL'));
  assert.deepEqual(theory.map((e) => e.seq), [1, 2, 3, 4]);
  assert.equal(lab.length, 3);
  assert.deepEqual(lab.map((e) => e.batch_id), ['d1-A1', 'd1-A2', 'd1-A3']);
  assert.ok(lab.every((e) => e.seq === 1));
  assert.deepEqual(lab[0].faculty_ids, ['f2']);
});

test('expectedSessions: per-batch lab with only the whole batch falls back to the whole batch', () => {
  const s = baseState();
  s.divisions[0].batches = makeBatches('d1', [], 0, 60);
  const lab = expectedSessions(s).filter((e) => e.offering_id === 'o-dsl');
  assert.equal(lab.length, 1);
  assert.equal(lab[0].batch_id, 'd1-ALL');
});

test('expectedSessions: weekly_count override beats the subject default; 0 gives none', () => {
  const s = baseState();
  s.offerings[0].weekly_count = 2;
  assert.equal(expectedSessions(s).filter((e) => e.offering_id === 'o-ds').length, 2);
  s.offerings[0].weekly_count = 0;
  assert.equal(expectedSessions(s).filter((e) => e.offering_id === 'o-ds').length, 0);
});

test('expectedSessions: per_batch=false on a lab uses the whole batch', () => {
  const s = baseState();
  s.offerings[1].per_batch = false;
  const lab = expectedSessions(s).filter((e) => e.offering_id === 'o-dsl');
  assert.deepEqual(lab.map((e) => e.batch_id), ['d1-ALL']);
});

test('expectedSessions: session faculty = batch rows + batch-null rows, deduped', () => {
  const s = baseState();
  s.offerings[1].faculty = [
    { batch_id: 'd1-A1', faculty_id: 'f1', role: 'lead' },
    { batch_id: null, faculty_id: 'f2', role: 'lead' },
    { batch_id: 'd1-A1', faculty_id: 'f2', role: 'assist' }, // duplicate of the batch-null row
    { batch_id: 'd1-A2', faculty_id: 'f1', role: 'lead' },
  ];
  const lab = expectedSessions(s).filter((e) => e.offering_id === 'o-dsl');
  const by = Object.fromEntries(lab.map((e) => [e.batch_id, e.faculty_ids]));
  assert.deepEqual(by['d1-A1'], ['f1', 'f2']);
  assert.deepEqual(by['d1-A2'], ['f1', 'f2']);
  assert.deepEqual(by['d1-A3'], ['f2']);
});

test('expectedSessions is deterministic and tolerates empty state', () => {
  assert.deepEqual(expectedSessions(baseState()), expectedSessions(baseState()));
  assert.deepEqual(expectedSessions({}), []);
  assert.deepEqual(expectedSessions(null), []);
});

test('plan: adds missing sessions from nothing', () => {
  const expected = expectedSessions(baseState());
  const plan = planSessionSync({ expected, existing: [] });
  assert.equal(plan.toCreate.length, 7);
  assert.deepEqual(plan.toDeleteIds, []);
  assert.deepEqual(plan.placedSurplus, []);
  assert.equal(plan.kept, 0);
  assert.deepEqual(plan.toCreate.filter((c) => c.offering_id === 'o-ds').map((c) => c.seq), [1, 2, 3, 4]);
  assert.deepEqual(plan.toCreate[0].faculty_ids, ['f1']);
});

test('plan: tops up only the missing seqs', () => {
  const expected = expectedSessions(baseState());
  const existing = [
    { id: 'a', offering_id: 'o-ds', batch_id: 'd1-ALL', seq: 1, placed: false },
    { id: 'b', offering_id: 'o-ds', batch_id: 'd1-ALL', seq: 3, placed: true },
  ];
  const plan = planSessionSync({ expected, existing });
  assert.deepEqual(plan.toCreate.filter((c) => c.offering_id === 'o-ds').map((c) => c.seq), [2, 4]);
  assert.equal(plan.kept, 2);
});

test('plan: removes surplus unplaced sessions, highest seq first', () => {
  const s = baseState();
  s.offerings[0].weekly_count = 2;
  const existing = [1, 2, 3, 4].map((seq) => ({ id: `s${seq}`, offering_id: 'o-ds', batch_id: 'd1-ALL', seq, placed: false }));
  const plan = planSessionSync({ expected: expectedSessions(s).filter((e) => e.offering_id === 'o-ds'), existing });
  assert.deepEqual(plan.toDeleteIds, ['s4', 's3']);
  assert.deepEqual(plan.toCreate, []);
  assert.equal(plan.kept, 2);
});

test('plan: never deletes placed sessions, reports placed surplus', () => {
  const s = baseState();
  s.offerings[0].weekly_count = 1;
  const existing = [
    { id: 's1', offering_id: 'o-ds', batch_id: 'd1-ALL', seq: 1, placed: false },
    { id: 's2', offering_id: 'o-ds', batch_id: 'd1-ALL', seq: 2, placed: true },
    { id: 's3', offering_id: 'o-ds', batch_id: 'd1-ALL', seq: 3, placed: true },
    { id: 's4', offering_id: 'o-ds', batch_id: 'd1-ALL', seq: 4, placed: false },
  ];
  const plan = planSessionSync({ expected: expectedSessions(s).filter((e) => e.offering_id === 'o-ds'), existing });
  assert.deepEqual(plan.toDeleteIds, ['s4', 's1']);
  assert.ok(!plan.toDeleteIds.includes('s2') && !plan.toDeleteIds.includes('s3'));
  assert.deepEqual(plan.placedSurplus, [{ offering_id: 'o-ds', batch_id: 'd1-ALL', count: 1 }]);
  assert.equal(plan.kept, 2);
});

test('plan: all-placed surplus is only reported', () => {
  const existing = [1, 2, 3].map((seq) => ({ id: `p${seq}`, offering_id: 'o-x', batch_id: 'b-x', seq, placed: true }));
  const plan = planSessionSync({ expected: [{ offering_id: 'o-x', batch_id: 'b-x', seq: 1, faculty_ids: [] }], existing });
  assert.deepEqual(plan.toDeleteIds, []);
  assert.deepEqual(plan.placedSurplus, [{ offering_id: 'o-x', batch_id: 'b-x', count: 2 }]);
  assert.equal(plan.kept, 3);
});

test('plan: sessions of an offering/batch that is no longer expected are surplus', () => {
  const existing = [
    { id: 'u', offering_id: 'gone', batch_id: 'b', seq: 1, placed: false },
    { id: 'p', offering_id: 'gone', batch_id: 'b', seq: 2, placed: true },
  ];
  const plan = planSessionSync({ expected: [], existing });
  assert.deepEqual(plan.toDeleteIds, ['u']);
  assert.deepEqual(plan.placedSurplus, [{ offering_id: 'gone', batch_id: 'b', count: 1 }]);
});

test('plan: idempotent', () => {
  const expected = expectedSessions(baseState());
  const first = planSessionSync({ expected, existing: [] });
  const after = apply([], first);
  const second = planSessionSync({ expected, existing: after });
  assert.deepEqual(second.toCreate, []);
  assert.deepEqual(second.toDeleteIds, []);
  assert.deepEqual(second.placedSurplus, []);
  assert.equal(second.kept, expected.length);
});

test('plan: idempotent after surplus removal with placed leftovers', () => {
  const expected = [{ offering_id: 'o', batch_id: 'b', seq: 1, faculty_ids: [] }, { offering_id: 'o', batch_id: 'b', seq: 2, faculty_ids: [] }];
  const existing = [1, 2, 3, 4].map((seq) => ({ id: `s${seq}`, offering_id: 'o', batch_id: 'b', seq, placed: seq === 3 }));
  const first = planSessionSync({ expected, existing });
  const after = apply(existing, first);
  const second = planSessionSync({ expected, existing: after });
  assert.deepEqual(second.toCreate, []);
  assert.deepEqual(second.toDeleteIds, []);
});

test('plan: whole vs batch changes (per_batch toggled) swap the targets', () => {
  const s = baseState();
  const before = expectedSessions(s);
  const existing = before.map((e, i) => ({ id: `e${i}`, offering_id: e.offering_id, batch_id: e.batch_id, seq: e.seq, placed: false }));
  s.offerings[1].per_batch = false; // lab now on the whole batch
  const plan = planSessionSync({ expected: expectedSessions(s), existing });
  assert.equal(plan.toCreate.length, 1);
  assert.equal(plan.toCreate[0].batch_id, 'd1-ALL');
  assert.equal(plan.toDeleteIds.length, 3); // the three per-batch lab sessions
});

test('plan: per-batch labs count each non-whole batch separately', () => {
  const s = clone(baseState());
  s.offerings[1].weekly_count = 2;
  const exp = expectedSessions(s).filter((e) => e.offering_id === 'o-dsl');
  assert.equal(exp.length, 6);
  const plan = planSessionSync({
    expected: exp,
    existing: [{ id: 'x', offering_id: 'o-dsl', batch_id: 'd1-A2', seq: 1, placed: false }],
  });
  assert.equal(plan.toCreate.length, 5);
  assert.deepEqual(plan.toCreate.filter((c) => c.batch_id === 'd1-A2').map((c) => c.seq), [2]);
});

test('plan: tolerates missing input', () => {
  assert.deepEqual(planSessionSync(), { toCreate: [], toDeleteIds: [], placedSurplus: [], kept: 0 });
  assert.deepEqual(planSessionSync({}), { toCreate: [], toDeleteIds: [], placedSurplus: [], kept: 0 });
});
