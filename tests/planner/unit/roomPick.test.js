import test from 'node:test';
import assert from 'node:assert/strict';
import { pickRoom } from '../../../services/planner/domain/roomPick.js';

const room = (room_id, over = {}) => ({
  room_id,
  is_lab: false,
  capacity: 60,
  name: room_id,
  building_name: 'Main',
  ...over,
});

const theory = { kind: 'theory' };
const lab = { kind: 'lab' };
const division = { student_count: 60, home_room_id: null };
const wholeBatch = { is_whole: true, student_count: 60 };
const subBatch = { is_whole: false, student_count: 20 };

const pick = (over) =>
  pickRoom({
    subject: theory,
    division,
    batch: wholeBatch,
    poolRooms: [],
    busyRoomIds: new Set(),
    ...over,
  });

test('keeps the current room when free and in the pool, whatever its kind', () => {
  const poolRooms = [room('small', { capacity: 10 }), room('L1', { is_lab: true, capacity: 200 }), room('big', { capacity: 100 })];
  assert.deepEqual(pick({ poolRooms, currentRoomId: 'L1' }), { room_id: 'L1' });
  assert.deepEqual(pick({ poolRooms, currentRoomId: 'small' }), { room_id: 'small' });
});

test('current room is ignored when busy or not in the pool', () => {
  const poolRooms = [room('a', { capacity: 70 }), room('b', { capacity: 90 })];
  assert.deepEqual(pick({ poolRooms, currentRoomId: 'b', busyRoomIds: new Set(['b']) }), { room_id: 'a' });
  assert.deepEqual(pick({ poolRooms, currentRoomId: 'gone' }), { room_id: 'a' });
});

test('theory prefers the home room over a smaller free room', () => {
  const poolRooms = [room('small', { capacity: 61 }), room('home', { capacity: 120 })];
  assert.deepEqual(pick({ poolRooms, division: { ...division, home_room_id: 'home' } }), { room_id: 'home' });
});

test('home room with unknown capacity is accepted', () => {
  const poolRooms = [room('small', { capacity: 61 }), room('home', { capacity: null })];
  assert.deepEqual(pick({ poolRooms, division: { ...division, home_room_id: 'home' } }), { room_id: 'home' });
});

test('a division WITH home classrooms uses only those: busy / too small / outside the pool -> no room (contract 10.3)', () => {
  const poolRooms = [room('home', { capacity: 120 }), room('other', { capacity: 80 })];
  const d = { ...division, home_room_id: 'home' };
  assert.deepEqual(pick({ poolRooms, division: d }), { room_id: 'home' });
  assert.match(pick({ poolRooms, division: d, busyRoomIds: new Set(['home']) }).reason, /classroom is already in use/);
  assert.equal(pick({ poolRooms: [room('home', { capacity: 30 }), room('other', { capacity: 80 })], division: d }).room_id, null);
  assert.match(pick({ poolRooms: [room('other', { capacity: 80 })], division: d }).reason, /none of them is a classroom in this term's room pool/);
  // a home room the pool marks as a lab is not usable for theory
  assert.equal(pick({ poolRooms: [room('home', { is_lab: true, capacity: 120 }), room('other', { capacity: 80 })], division: d }).room_id, null);
});

test('two home classrooms: the first free one in the admin order; the current room only if it is one of them', () => {
  const poolRooms = [room('a', { capacity: 120 }), room('b', { capacity: 120 }), room('z', { capacity: 70 })];
  const d = { ...division, home_room_ids: ['b', 'a'] };
  assert.deepEqual(pick({ poolRooms, division: d }), { room_id: 'b' });
  assert.deepEqual(pick({ poolRooms, division: d, busyRoomIds: new Set(['b']) }), { room_id: 'a' });
  assert.equal(pick({ poolRooms, division: d, busyRoomIds: new Set(['a', 'b']) }).room_id, null);
  assert.deepEqual(pick({ poolRooms, division: d, currentRoomId: 'z' }), { room_id: 'b' }, 'a current room outside the home rooms is not kept');
  assert.deepEqual(pick({ poolRooms, division: d, currentRoomId: 'a' }), { room_id: 'a' });
});

test('a division without home classrooms prefers classrooms that are no division home room', () => {
  const poolRooms = [room('small', { capacity: 65 }), room('big', { capacity: 120 })];
  assert.deepEqual(pick({ poolRooms }), { room_id: 'small' });
  assert.deepEqual(pick({ poolRooms, reservedRoomIds: new Set(['small']) }), { room_id: 'big' });
  assert.deepEqual(pick({ poolRooms: [poolRooms[0]], reservedRoomIds: new Set(['small']) }), { room_id: 'small' }, 'still usable when it is the only one');
});

test('labs ignore the home room', () => {
  const poolRooms = [room('home', { capacity: 120 }), room('L1', { is_lab: true, capacity: 30 })];
  const r = pick({ subject: lab, batch: subBatch, poolRooms, division: { ...division, home_room_id: 'home' } });
  assert.deepEqual(r, { room_id: 'L1' });
});

test('chooses the smallest free room of the right kind that fits', () => {
  const poolRooms = [
    room('big', { capacity: 120 }),
    room('fit', { capacity: 65 }),
    room('tiny', { capacity: 30 }),
    room('lab', { is_lab: true, capacity: 62 }),
  ];
  assert.deepEqual(pick({ poolRooms }), { room_id: 'fit' });
});

test('exact capacity fits', () => {
  assert.deepEqual(pick({ poolRooms: [room('x', { capacity: 60 })] }), { room_id: 'x' });
});

test('unknown capacity ranks after every known fit', () => {
  const poolRooms = [room('unk', { capacity: null }), room('known', { capacity: 200 })];
  assert.deepEqual(pick({ poolRooms }), { room_id: 'known' });
  assert.deepEqual(pick({ poolRooms: [room('unk', { capacity: null })] }), { room_id: 'unk' });
  assert.deepEqual(pick({ poolRooms: [room('unk', { capacity: undefined })] }), { room_id: 'unk' });
});

test('known rooms that are too small lose to an unknown-capacity room', () => {
  const poolRooms = [room('small', { capacity: 10 }), room('unk', { capacity: null })];
  assert.deepEqual(pick({ poolRooms }), { room_id: 'unk' });
});

test('ties break by building then name, numerically', () => {
  const poolRooms = [
    room('r10', { name: 'R10', building_name: 'A', capacity: 70 }),
    room('r2', { name: 'R2', building_name: 'A', capacity: 70 }),
    room('b1', { name: 'R1', building_name: 'B', capacity: 70 }),
  ];
  assert.deepEqual(pick({ poolRooms }), { room_id: 'r2' });
  assert.deepEqual(pick({ poolRooms: poolRooms.filter((r) => r.room_id !== 'r2') }), { room_id: 'r10' });
  assert.deepEqual(pick({ poolRooms: [poolRooms[2], poolRooms[0]] }), { room_id: 'r10' });
});

test('sub-batch uses its own student count; whole batch and missing batch use the division count', () => {
  const poolRooms = [room('s', { capacity: 25, is_lab: true }), room('b', { capacity: 70, is_lab: true })];
  assert.deepEqual(pick({ subject: lab, batch: subBatch, poolRooms }), { room_id: 's' });
  assert.deepEqual(pick({ subject: lab, batch: wholeBatch, poolRooms }), { room_id: 'b' });
  assert.deepEqual(pick({ subject: lab, batch: null, poolRooms }), { room_id: 'b' });
  assert.deepEqual(pick({ subject: lab, batch: undefined, poolRooms }), { room_id: 'b' });
});

test('busy rooms are skipped', () => {
  const poolRooms = [room('a', { capacity: 61 }), room('b', { capacity: 62 })];
  assert.deepEqual(pick({ poolRooms, busyRoomIds: new Set(['a']) }), { room_id: 'b' });
});

test('reason: no lab room in the pool', () => {
  const r = pick({ subject: lab, batch: subBatch, poolRooms: [room('a')] });
  assert.equal(r.room_id, null);
  assert.match(r.reason, /No lab room is in this term's room pool/);
});

test('reason: no classroom in the pool', () => {
  const r = pick({ poolRooms: [room('L', { is_lab: true })] });
  assert.equal(r.room_id, null);
  assert.match(r.reason, /No classroom is in this term's room pool/);
  assert.match(pick({ poolRooms: [] }).reason, /No classroom is in this term's room pool/);
});

test('reason: every room of the kind is busy', () => {
  const two = pick({ poolRooms: [room('a'), room('b')], busyRoomIds: new Set(['a', 'b']) });
  assert.equal(two.room_id, null);
  assert.equal(two.reason, 'All 2 classrooms are already in use at that time.');
  const one = pick({ subject: lab, batch: subBatch, poolRooms: [room('L', { is_lab: true })], busyRoomIds: new Set(['L']) });
  assert.equal(one.reason, 'All 1 lab is already in use at that time.');
});

test('reason: free rooms exist but none is big enough', () => {
  const r = pick({ poolRooms: [room('a', { capacity: 30 }), room('b', { capacity: 40 })] });
  assert.equal(r.room_id, null);
  assert.equal(r.reason, 'No free classroom is big enough for 60 students (the largest free classroom seats 40).');
  const l = pick({ subject: lab, batch: subBatch, poolRooms: [room('L', { is_lab: true, capacity: 10 })] });
  assert.match(l.reason, /No free lab is big enough for 20 students \(the largest free lab seats 10\)/);
});

test('a too-small free room plus a big busy one reports too small, not busy', () => {
  const r = pick({
    poolRooms: [room('a', { capacity: 30 }), room('b', { capacity: 100 })],
    busyRoomIds: new Set(['b']),
  });
  assert.equal(r.room_id, null);
  assert.match(r.reason, /big enough/);
});

test('tolerates missing arguments and array busy list', () => {
  assert.equal(pickRoom().room_id, null);
  assert.equal(pickRoom({}).room_id, null);
  assert.equal(typeof pickRoom({}).reason, 'string');
  assert.deepEqual(
    pickRoom({ subject: theory, division, batch: wholeBatch, poolRooms: [room('a'), null, {}], busyRoomIds: undefined }),
    { room_id: 'a' },
  );
  assert.deepEqual(
    pickRoom({ subject: theory, division, batch: wholeBatch, poolRooms: [room('a'), room('b')], busyRoomIds: ['a'] }),
    { room_id: 'b' },
  );
});

// ---------------------------------------------------------------- lab sharing (contract 8.7)

const lab62 = (id, over = {}) => room(id, { is_lab: true, capacity: 62, ...over });
const loads = (o) => new Map(Object.entries(o));
const labPick = (over) => pick({ subject: lab, batch: { is_whole: false, student_count: 30 }, ...over });
const L = (sharedPeak, exclusiveBusy = false, extra = {}) => ({ exclusiveBusy, sharedPeak, ...extra });

test('roomLoads: a lab packs into the fullest lab that still has space', () => {
  const poolRooms = [lab62('a'), lab62('b'), lab62('c')];
  assert.deepEqual(labPick({ poolRooms }), { room_id: 'a' }, 'all empty: smallest capacity, then name');
  assert.deepEqual(labPick({ poolRooms, roomLoads: loads({ b: L(30) }) }), { room_id: 'b' });
  assert.deepEqual(
    labPick({ poolRooms, roomLoads: loads({ a: L(30), b: L(31), c: L(0) }) }),
    { room_id: 'b' },
    '31 + 30 = 61 <= 62 and b is the fullest',
  );
  // the fullest room is full: fall to the next fullest that fits
  assert.deepEqual(labPick({ poolRooms, roomLoads: loads({ a: L(30), b: L(60) }) }), { room_id: 'a' });
  // plain-object roomLoads work too
  assert.deepEqual(labPick({ poolRooms, roomLoads: { c: L(10) } }), { room_id: 'c' });
});

test('roomLoads: ties on load prefer the smaller capacity, then the name', () => {
  const poolRooms = [lab62('big', { capacity: 100, name: 'A big' }), lab62('small', { capacity: 40, name: 'Z small' }), lab62('mid', { capacity: 40, name: 'B mid' })];
  assert.deepEqual(labPick({ poolRooms }), { room_id: 'mid' });
  assert.deepEqual(labPick({ poolRooms, roomLoads: loads({ big: L(10), small: L(10) }) }), { room_id: 'small' });
});

test('roomLoads: exclusively busy labs are never used, busyRoomIds is merged in', () => {
  const poolRooms = [lab62('a'), lab62('b')];
  assert.deepEqual(labPick({ poolRooms, roomLoads: loads({ a: L(0, true) }) }), { room_id: 'b' });
  assert.deepEqual(labPick({ poolRooms, busyRoomIds: new Set(['a']), roomLoads: loads({ b: L(30) }) }), { room_id: 'b' });
  const none = labPick({ poolRooms, roomLoads: loads({ a: L(0, true), b: L(0, true) }) });
  assert.equal(none.reason, 'All 2 labs are already in use at that time.');
});

test('roomLoads: full labs give a "no space" reason, too-small labs keep the "big enough" reason', () => {
  const full = labPick({ poolRooms: [lab62('a'), lab62('b')], roomLoads: loads({ a: L(60), b: L(40) }) });
  assert.equal(full.room_id, null);
  assert.equal(full.reason, 'No lab has space for 30 more students at that time.');
  const small = labPick({ poolRooms: [lab62('a', { capacity: 20 })] });
  assert.equal(small.reason, 'No free lab is big enough for 30 students (the largest free lab seats 20).');
});

test('roomLoads: a lab needs sharedPeak + need <= capacity (exact fit allowed)', () => {
  const poolRooms = [lab62('a', { capacity: 60 })];
  assert.deepEqual(labPick({ poolRooms, roomLoads: loads({ a: L(30) }) }), { room_id: 'a' });
  assert.equal(labPick({ poolRooms, roomLoads: loads({ a: L(31) }) }).room_id, null);
});

test('roomLoads: unknown-capacity labs are only a last resort and stay exclusive', () => {
  const poolRooms = [lab62('u', { capacity: null, name: 'A unknown' }), lab62('k')];
  assert.deepEqual(labPick({ poolRooms }), { room_id: 'k' }, 'a capacity-known lab that fits wins');
  assert.deepEqual(labPick({ poolRooms, roomLoads: loads({ k: L(0, true) }) }), { room_id: 'u' });
  assert.deepEqual(labPick({ poolRooms, roomLoads: loads({ k: L(40) }) }), { room_id: 'u' }, 'k is full');
  assert.equal(
    labPick({ poolRooms: [lab62('u', { capacity: null })], roomLoads: loads({ u: L(0, false, { shared: true }) }) }).room_id,
    null,
    'an unknown-capacity room with a shared row is not exclusively free',
  );
});

test('roomLoads: a lab never goes to a non-lab room, whole-batch labs need the whole division', () => {
  assert.equal(labPick({ poolRooms: [room('c', { capacity: 100 })] }).room_id, null);
  const whole = pick({ subject: lab, batch: wholeBatch, poolRooms: [lab62('a', { capacity: 62 })], roomLoads: loads({ a: L(10) }) });
  assert.equal(whole.room_id, null, '60 + 10 > 62');
  assert.deepEqual(pick({ subject: lab, batch: wholeBatch, poolRooms: [lab62('a', { capacity: 70 })], roomLoads: loads({ a: L(10) }) }), { room_id: 'a' });
});

test('roomLoads: theory treats any shared load as busy (and never shares)', () => {
  const poolRooms = [room('a', { capacity: 70 }), room('b', { capacity: 80 })];
  assert.deepEqual(pick({ poolRooms, roomLoads: loads({ a: L(5) }) }), { room_id: 'b' });
  assert.deepEqual(pick({ poolRooms, roomLoads: loads({ a: L(0, false, { shared: true }) }) }), { room_id: 'b' });
  assert.equal(pick({ poolRooms, division: { ...division, home_room_id: 'a' }, roomLoads: loads({ a: L(1) }) }).room_id, null, 'a restricted division never falls through to another room');
  const all = pick({ poolRooms, roomLoads: loads({ a: L(0, true), b: L(2) }) });
  assert.equal(all.reason, 'All 2 classrooms are already in use at that time.');
});

test('roomLoads: the current room is kept only while it can still host the session', () => {
  const poolRooms = [lab62('a'), lab62('b')];
  // a shareable lab keeps its room next to other labs while there is space ...
  assert.deepEqual(labPick({ poolRooms, currentRoomId: 'a', roomLoads: loads({ a: L(30), b: L(40) }) }), { room_id: 'a' });
  // ... and moves on when the room became full or exclusively busy
  assert.deepEqual(labPick({ poolRooms, currentRoomId: 'a', roomLoads: loads({ a: L(40) }) }), { room_id: 'b' });
  assert.deepEqual(labPick({ poolRooms, currentRoomId: 'a', roomLoads: loads({ a: L(0, true) }) }), { room_id: 'b' });
  // theory never keeps a room that has shared load
  assert.deepEqual(pick({ poolRooms: [room('x'), room('y', { capacity: 99 })], currentRoomId: 'x', roomLoads: loads({ x: L(1) }) }), { room_id: 'y' });
  // a lab session sitting in a classroom (manual choice) is exclusive there
  assert.deepEqual(labPick({ poolRooms: [room('c'), lab62('a')], currentRoomId: 'c' }), { room_id: 'c' });
  assert.deepEqual(labPick({ poolRooms: [room('c'), lab62('a')], currentRoomId: 'c', roomLoads: loads({ c: L(0, true) }) }), { room_id: 'a' });
});

test('roomLoads: without roomLoads a lab behaves as before (smallest free lab that fits)', () => {
  const poolRooms = [lab62('big', { capacity: 100 }), lab62('small', { capacity: 40 })];
  assert.deepEqual(labPick({ poolRooms }), { room_id: 'small' });
  assert.deepEqual(labPick({ poolRooms, busyRoomIds: new Set(['small']) }), { room_id: 'big' });
});

test('a lab bigger than a room on its own never fits it: not picked, not kept as the current room', () => {
  const small = lab62('small', { capacity: 30 });
  const big = lab62('big', { capacity: 62 });
  const wholeLab = (over) => pick({ subject: lab, batch: wholeBatch, ...over }); // 60 students
  assert.deepEqual(wholeLab({ poolRooms: [small, big] }), { room_id: 'big' });
  assert.deepEqual(wholeLab({ poolRooms: [small, big], currentRoomId: 'small' }), { room_id: 'big' }, 'the current room is too small');
  const none = wholeLab({ poolRooms: [small], currentRoomId: 'small' });
  assert.equal(none.room_id, null);
  assert.equal(none.reason, 'No free lab is big enough for 60 students (the largest free lab seats 30).');
  // exactly the room size is fine
  assert.deepEqual(labPick({ poolRooms: [small], currentRoomId: 'small' }), { room_id: 'small' });
});
