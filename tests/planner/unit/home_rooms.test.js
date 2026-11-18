// Contract 10.3: home classrooms (at most 2 per division) restrict a division's THEORY to those rooms.
import test from 'node:test';
import assert from 'node:assert/strict';
import { homeRoomIds, allHomeRoomIds, violatesHomeRooms, MAX_HOME_ROOMS, checkPlacement } from '../../../services/planner/domain/index.js';
import { generate, OccupancyModel, buildEngineConfig } from '../../../services/planner/engine/index.js';
import { mini, sessionOf, roomId, put, run, theoryWorld, T } from './ruleKit.js';

test('homeRoomIds: 0-2 distinct ids from home_room_ids or the two raw columns', () => {
  assert.equal(MAX_HOME_ROOMS, 2);
  assert.deepEqual(homeRoomIds(null), []);
  assert.deepEqual(homeRoomIds({ home_room_id: 'a' }), ['a']);
  assert.deepEqual(homeRoomIds({ home_room_id: 'a', home_room2_id: 'b' }), ['a', 'b']);
  assert.deepEqual(homeRoomIds({ home_room_id: null, home_room2_id: 'b' }), ['b']);
  assert.deepEqual(homeRoomIds({ home_room_ids: ['a', 'a', 'b', 'c'] }), ['a', 'b'], 'de-duplicated and capped at 2');
  assert.deepEqual([...allHomeRoomIds([{ home_room_id: 'a' }, { home_room_ids: ['b', 'a'] }])].sort(), ['a', 'b']);
});

test('violatesHomeRooms: theory only, only when the division has home rooms', () => {
  const d = { home_room_ids: ['a', 'b'] };
  assert.equal(violatesHomeRooms({ subject: { kind: 'theory' }, division: d, room_id: 'c' }), true);
  assert.equal(violatesHomeRooms({ subject: { kind: 'theory' }, division: d, room_id: 'b' }), false);
  assert.equal(violatesHomeRooms({ subject: { kind: 'lab' }, division: d, room_id: 'c' }), false, 'labs are never restricted');
  assert.equal(violatesHomeRooms({ subject: { kind: 'theory' }, division: { home_room_ids: [] }, room_id: 'c' }), false);
  assert.equal(violatesHomeRooms({ subject: { kind: 'theory' }, division: d, room_id: null }), false);
});

test('checkPlacement: ROOM_NOT_HOME for a theory session in another room', () => {
  const base = { term: {}, subject: { kind: 'theory', duration_min: 60 }, weekday: 0, start_min: 510, room_id: 'c', poolRoomIds: new Set(['a', 'c']) };
  const bad = checkPlacement({ ...base, division: { name: 'A', home_room_ids: ['a'] } });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'ROOM_NOT_HOME');
  assert.equal(checkPlacement({ ...base, room_id: 'a', division: { name: 'A', home_room_ids: ['a'] } }).ok, true);
  assert.equal(checkPlacement({ ...base, division: { name: 'A' } }).ok, true, 'no home rooms: any pool room');
  assert.equal(checkPlacement(base).ok, true, 'no division given: unchanged behaviour');
  assert.equal(checkPlacement({ ...base, subject: { kind: 'lab', duration_min: 120 }, division: { name: 'A', home_room_ids: ['a'] } }).ok, true);
});

function twoDivisions() {
  const w = mini({
    rooms: [{ name: 'C1', cap: 70 }, { name: 'C2', cap: 70 }, { name: 'C3', cap: 65 }],
    faculty: ['A', 'B', 'C', 'D'],
    subjects: [{ code: 'T1', kind: 'theory', weekly: 3 }, { code: 'T2', kind: 'theory', weekly: 3 }],
    divisions: [{ name: 'X', students: 60, home: 'C1' }, { name: 'Y', students: 60, home: 'C2' }, { name: 'Z', students: 60 }],
    offerings: [
      { div: 'X', code: 'T1', faculty: 'A' }, { div: 'X', code: 'T2', faculty: 'B' },
      { div: 'Y', code: 'T1', faculty: 'C' }, { div: 'Y', code: 'T2', faculty: 'D' },
      { div: 'Z', code: 'T1', faculty: 'A' }, { div: 'Z', code: 'T2', faculty: 'B' },
    ],
  });
  return w;
}

test('generate: theory of a division with home rooms lands only there; a division without any avoids the home rooms', () => {
  const w = twoDivisions();
  const r = generate({ snapshot: w, seed: 1 });
  assert.equal(r.unplaced.length, 0, r.unplaced.map((u) => u.text).join(' | '));
  const roomOfSession = new Map();
  for (const u of r.units) for (const p of u.placements) roomOfSession.set(p.session_id, p.room_id);
  const rooms = (div) => new Set(w.sessions.filter((s) => w.divisions.find((d) => d.name === div).batches.some((b) => b.id === s.batch_id)).map((s) => roomOfSession.get(s.id)));
  assert.deepEqual([...rooms('X')], [roomId(w, 'C1')]);
  assert.deepEqual([...rooms('Y')], [roomId(w, 'C2')]);
  assert.deepEqual([...rooms('Z')], [roomId(w, 'C3')], 'Z has no home room: it takes the classroom nobody calls home');
});

test('model: a restricted division cannot be moved into another room by hand (checkRoom) and is refused when its rooms are busy', () => {
  const w = twoDivisions();
  const m = new OccupancyModel(w);
  const x = sessionOf(w, 'X', 'T1');
  assert.equal(m.evaluate(x.id, 0, T.s0830, { room_id: roomId(w, 'C3') }).detail, 'ROOM_NOT_HOME');
  assert.equal(m.evaluate(x.id, 0, T.s0830, { room_id: roomId(w, 'C1') }).ok, true);
});

test('room_type rule: theory outside the division\'s home classrooms is a hard issue', () => {
  const w = theoryWorld({ weekly: 2 });
  w.divisions[0].home_room_ids = [roomId(w, 'C1')];
  put(w, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1');
  put(w, 'CSE-A', 'DS', 'ALL', 2, 0, T.s0930, 'C2');
  const issues = run('room_type', w);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /not one of .* home classrooms/);
  assert.equal(issues[0].severity, 'hard');
  w.divisions[0].home_room_ids = [roomId(w, 'C1'), roomId(w, 'C2')];
  assert.deepEqual(run('room_type', w), [], 'both rooms are home rooms');
});

test('repair never trades one idle gap for a placement (hard no-idle-time rule on)', () => {
  // many tight divisions on a small teacher pool: whatever the repair does, no division day ends up with free time
  const w = mini({
    rooms: [{ name: 'C1', cap: 70 }, { name: 'C2', cap: 70 }, { name: 'C3', cap: 70 }],
    faculty: ['A', 'B', 'C'],
    subjects: ['T1', 'T2', 'T3', 'T4'].map((code) => ({ code, kind: 'theory', weekly: 4 })),
    divisions: [{ name: 'X', students: 60 }, { name: 'Y', students: 60 }, { name: 'Z', students: 60 }],
    offerings: ['X', 'Y', 'Z'].flatMap((div, i) => ['T1', 'T2', 'T3', 'T4'].map((code, j) => ({ div, code, faculty: 'ABC'[(i + j) % 3] }))),
  });
  const r = generate({ snapshot: w, seed: 3, config: buildEngineConfig([]) });
  const byDivDay = new Map();
  for (const u of r.units) for (const p of u.placements) {
    const s = w.sessions.find((x) => x.id === p.session_id);
    const div = w.divisions.find((d) => d.batches.some((b) => b.id === s.batch_id)).name;
    const k = `${div}|${p.weekday}`;
    (byDivDay.get(k) || byDivDay.set(k, []).get(k)).push([p.start_min, p.start_min + s.duration_min]);
  }
  const breaks = w.term.breaks.map((b) => [b.start_min, b.end_min]);
  const brk = (a, b) => breaks.reduce((t, [s, e]) => t + Math.max(0, Math.min(b, e) - Math.max(a, s)), 0);
  for (const [k, list] of byDivDay) {
    list.sort((a, b) => a[0] - b[0]);
    let idle = 0;
    for (let i = 1; i < list.length; i++) idle += Math.max(0, list[i][0] - list[i - 1][1] - brk(list[i - 1][1], list[i][0]));
    assert.equal(idle, 0, `${k} has ${idle} idle minutes`);
  }
});
