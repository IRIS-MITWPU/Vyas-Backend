import test from 'node:test';
import assert from 'node:assert/strict';
import { occupancyRows, batchResourceIds } from '../../../services/planner/domain/occupancy.js';

const division = {
  batches: [
    { id: 'W', is_whole: true },
    { id: 'A1', is_whole: false },
    { id: 'A2', is_whole: false },
    { id: 'A3', is_whole: false },
  ],
};

const placed = (over = {}) => ({
  id: 's1',
  batch_id: 'W',
  weekday: 1,
  start_min: 570,
  end_min: 630,
  room_id: 'R1',
  faculty_ids: ['F1'],
  ...over,
});

const ids = (rows, kind) => rows.filter((r) => r.kind === kind).map((r) => r.resource_id);

test('whole-batch session occupies the whole batch and every non-whole batch', () => {
  const rows = occupancyRows({ session: placed(), division });
  assert.deepEqual(ids(rows, 'batch'), ['W', 'A1', 'A2', 'A3']);
  assert.deepEqual(ids(rows, 'faculty'), ['F1']);
  assert.deepEqual(ids(rows, 'room'), ['R1']);
  assert.equal(rows.length, 6);
  for (const r of rows) {
    assert.equal(r.weekday, 1);
    assert.equal(r.start_min, 570);
    assert.equal(r.end_min, 630);
  }
});

test('non-whole batch session occupies only its own batch', () => {
  const rows = occupancyRows({ session: placed({ batch_id: 'A2' }), division });
  assert.deepEqual(ids(rows, 'batch'), ['A2']);
});

test('parallel batch labs share no batch resource id; the whole batch overlaps each of them', () => {
  const a1 = ids(occupancyRows({ session: placed({ batch_id: 'A1', room_id: 'L1' }), division }), 'batch');
  const a2 = ids(occupancyRows({ session: placed({ batch_id: 'A2', room_id: 'L2' }), division }), 'batch');
  const w = ids(occupancyRows({ session: placed(), division }), 'batch');
  assert.equal(a1.filter((x) => a2.includes(x)).length, 0);
  assert.ok(w.includes('A1') && w.includes('A2'));
});

test('one faculty row per distinct faculty id, de-duplicated', () => {
  const rows = occupancyRows({ session: placed({ faculty_ids: ['F1', 'F2', 'F1'] }), division });
  assert.deepEqual(ids(rows, 'faculty'), ['F1', 'F2']);
});

test('missing or empty faculty list gives no faculty rows', () => {
  assert.deepEqual(ids(occupancyRows({ session: placed({ faculty_ids: [] }), division }), 'faculty'), []);
  assert.deepEqual(ids(occupancyRows({ session: placed({ faculty_ids: undefined }), division }), 'faculty'), []);
});

test('unplaced sessions give no rows', () => {
  assert.deepEqual(occupancyRows({ session: placed({ weekday: null }), division }), []);
  assert.deepEqual(occupancyRows({ session: placed({ start_min: null }), division }), []);
  assert.deepEqual(occupancyRows({ session: placed({ end_min: null }), division }), []);
  assert.deepEqual(occupancyRows({ session: placed({ room_id: null }), division }), []);
  assert.deepEqual(
    occupancyRows({ session: placed({ weekday: null, start_min: null, end_min: null, room_id: null }), division }),
    [],
  );
});

test('weekday 0 and start_min 0 count as placed', () => {
  const rows = occupancyRows({ session: placed({ weekday: 0, start_min: 0, end_min: 60 }), division });
  assert.equal(rows.length, 6);
});

test('never throws on bad input', () => {
  assert.deepEqual(occupancyRows(), []);
  assert.deepEqual(occupancyRows({}), []);
  assert.deepEqual(occupancyRows({ session: null, division: null }), []);
  const rows = occupancyRows({ session: placed(), division: null });
  assert.deepEqual(ids(rows, 'batch'), ['W']);
  const rows2 = occupancyRows({ session: placed({ batch_id: null }), division });
  assert.deepEqual(ids(rows2, 'batch'), []);
});

test('batch not found in the division falls back to its own id', () => {
  assert.deepEqual(batchResourceIds(division, 'ZZ'), ['ZZ']);
});

test('batchResourceIds', () => {
  assert.deepEqual(batchResourceIds(division, 'W'), ['W', 'A1', 'A2', 'A3']);
  assert.deepEqual(batchResourceIds(division, 'A3'), ['A3']);
  assert.deepEqual(batchResourceIds({ batches: [{ id: 'W', is_whole: true }] }, 'W'), ['W']);
  assert.deepEqual(batchResourceIds(division, null), []);
  assert.deepEqual(batchResourceIds(undefined, 'X'), ['X']);
  assert.deepEqual(batchResourceIds({ batches: [null, { id: 'W', is_whole: true }, { id: 'W', is_whole: false }] }, 'W'), ['W']);
});

test('shared_room: the room row gets kind lab_room, everything else is unchanged', () => {
  const shared = occupancyRows({ session: placed({ shared_room: true, batch_id: 'A1' }), division });
  assert.deepEqual(shared.map((r) => [r.kind, r.resource_id]), [['faculty', 'F1'], ['lab_room', 'R1'], ['batch', 'A1']]);
  assert.ok(shared.every((r) => r.weekday === 1 && r.start_min === 570 && r.end_min === 630));
  assert.equal(shared.filter((r) => r.kind === 'room').length, 0);
  // absent / false / anything but boolean true keeps the exclusive 'room' kind
  for (const v of [undefined, false, null, 0, 'true', 1]) {
    const rows = occupancyRows({ session: placed({ shared_room: v }), division });
    assert.deepEqual(rows.filter((r) => r.kind === 'room').map((r) => r.resource_id), ['R1'], `shared_room=${String(v)}`);
    assert.equal(rows.filter((r) => r.kind === 'lab_room').length, 0);
  }
  // an unplaced session stays empty even when flagged shared
  assert.deepEqual(occupancyRows({ session: placed({ shared_room: true, room_id: null }), division }), []);
});
