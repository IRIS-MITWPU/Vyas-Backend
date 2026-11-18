import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../../../services/planner/domain/readiness.js';
import { computeReadiness, checks, ISSUE_CODES } from '../../../services/planner/domain/readiness.js';
import { baseState } from '../fixtures/stateBuilder.js';
import { buildSemesterState } from '../fixtures/semesterFixture.js';

const codes = (issues) => issues.map((i) => i.code);

test('NO_DIVISIONS and NO_CLASSROOM_ROOM are registered', () => {
  for (const c of ['NO_DIVISIONS', 'NO_CLASSROOM_ROOM']) {
    assert.ok(ISSUE_CODES.includes(c), c);
    assert.equal(typeof checks[c], 'function', c);
  }
});

// ---- NO_DIVISIONS
test('NO_DIVISIONS: pass', () => assert.deepEqual(R.noDivisions(baseState()), []));
test('NO_DIVISIONS: fail', () => {
  const s = baseState();
  s.divisions = [];
  s.offerings = [];
  const [i, ...rest] = R.noDivisions(s);
  assert.equal(rest.length, 0);
  assert.equal(i.code, 'NO_DIVISIONS');
  assert.equal(i.severity, 'error');
  assert.deepEqual(i.entity, { type: 'term', id: 'term-1', tab: 'divisions' });
  assert.equal(computeReadiness(s).ready, false);
});
test('an empty term is never ready', () => {
  for (const s of [undefined, {}, { term: baseState().term }, { term: baseState().term, rooms: baseState().rooms }]) {
    const r = computeReadiness(s);
    assert.equal(r.ready, false);
    assert.ok(codes(r.errors).includes('NO_DIVISIONS'));
  }
});
test('the semester fixture still has neither new issue and stays ready', () => {
  const r = computeReadiness(buildSemesterState());
  assert.equal(r.ready, true);
  const all = [...r.errors, ...r.warnings, ...r.info];
  assert.ok(!codes(all).includes('NO_DIVISIONS'));
  assert.ok(!codes(all).includes('NO_CLASSROOM_ROOM'));
});

// ---- NO_CLASSROOM_ROOM
test('NO_CLASSROOM_ROOM: pass', () => assert.deepEqual(R.noClassroomRoom(baseState()), []));
test('NO_CLASSROOM_ROOM: pass when there are no theory offerings', () => {
  const s = baseState();
  s.rooms = s.rooms.filter((r) => r.is_lab);
  s.offerings = s.offerings.filter((o) => o.id !== 'o-ds');
  assert.deepEqual(R.noClassroomRoom(s), []);
});
test('NO_CLASSROOM_ROOM: fail', () => {
  const s = baseState();
  s.rooms = s.rooms.filter((r) => r.is_lab);
  s.divisions.forEach((d) => { d.home_room_id = null; }); // home classrooms outside the pool would be errors (contract 10.3)
  const [i, ...rest] = R.noClassroomRoom(s);
  assert.equal(rest.length, 0);
  assert.equal(i.code, 'NO_CLASSROOM_ROOM');
  assert.equal(i.severity, 'warning');
  assert.deepEqual(i.entity, { type: 'term', id: 'term-1', tab: 'rooms' });
  const r = computeReadiness(s);
  assert.ok(codes(r.warnings).includes('NO_CLASSROOM_ROOM'));
  assert.equal(r.ready, true, 'a warning alone keeps the term ready');
});
