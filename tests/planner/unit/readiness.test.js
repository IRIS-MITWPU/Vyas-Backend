import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../../../services/planner/domain/readiness.js';
import { computeReadiness, checks, ISSUE_CODES } from '../../../services/planner/domain/readiness.js';
import { baseState, clone, makeBatches } from '../fixtures/stateBuilder.js';
import { buildSemesterState } from '../fixtures/semesterFixture.js';

const codes = (issues) => issues.map((i) => i.code);

test('the base state is completely clean', () => {
  const r = computeReadiness(baseState());
  assert.equal(r.ready, true);
  assert.deepEqual(r.counts, { errors: 0, warnings: 0, info: 0 });
  assert.equal(r.stats.sessions_required, 7);
  assert.equal(r.stats.teachable_minutes_per_day, 480);
  assert.equal(r.stats.term_weeks, 15);
  assert.equal(r.stats.faculty_assigned, 2);
  assert.equal(r.stats.rooms, 4);
  assert.equal(r.stats.lab_rooms, 3);
  assert.equal(r.stats.divisions, 1);
  assert.equal(r.stats.subjects, 2);
  assert.equal(r.stats.offerings, 2);
});

test('checks registry: one exported function per code, all codes of the contract present', () => {
  const contract = [
    'OFFERING_NO_FACULTY', 'NO_DIVISIONS', 'NO_CLASSROOM_ROOM', 'DIVISION_NO_OFFERINGS', 'SUBJECT_UNUSED', 'NO_ROOMS_IN_POOL', 'NO_LAB_ROOM',
    'LAB_ROOMS_INSUFFICIENT', 'ROOM_TOO_SMALL', 'ROOM_CAPACITY_UNKNOWN', 'HOME_ROOM_NOT_IN_POOL',
    'FACULTY_WEEKLY_OVERLOAD', 'FACULTY_DAILY_CAP_INFEASIBLE', 'DIVISION_HOURS_OVER_CAPACITY',
    'SEMESTER_TOTAL_MISMATCH', 'FACULTY_NOT_LINKED', 'LAB_KIND_MISMATCH', 'LAB_NO_BATCHES', 'NO_DATES',
    'HOME_ROOM_IS_LAB', 'NO_HOME_ROOM', 'NO_BUILDING', // contract 10
  ];
  assert.deepEqual([...ISSUE_CODES].sort(), [...contract].sort());
  for (const c of contract) assert.equal(typeof checks[c], 'function', c);
  assert.equal(typeof R.offeringNoFaculty, 'function');
  assert.equal(typeof R.noDates, 'function');
});

test('every issue has code, severity, message and entity {type,id,tab}', () => {
  const s = baseState();
  s.offerings[0].faculty = [];
  s.rooms = [];
  s.term.end_date = null;
  s.faculty[0].profile_id = null;
  const r = computeReadiness(s);
  const all = [...r.errors, ...r.warnings, ...r.info];
  assert.ok(all.length >= 4);
  const types = ['term', 'faculty', 'subject', 'division', 'batch', 'offering', 'room'];
  const tabs = ['settings', 'faculty', 'subjects', 'divisions', 'offerings', 'rooms'];
  for (const i of all) {
    assert.ok(['error', 'warning', 'info'].includes(i.severity));
    assert.equal(typeof i.message, 'string');
    assert.ok(i.message.length > 10);
    assert.ok(types.includes(i.entity.type), i.code);
    assert.ok(tabs.includes(i.entity.tab), i.code);
    assert.ok('id' in i.entity);
  }
  assert.ok(r.errors.every((i) => i.severity === 'error'));
  assert.ok(r.warnings.every((i) => i.severity === 'warning'));
  assert.ok(r.info.every((i) => i.severity === 'info'));
});

test('computeReadiness tolerates empty / null state', () => {
  for (const s of [undefined, null, {}, { term: null, rooms: null }]) {
    const r = computeReadiness(s);
    assert.equal(typeof r.ready, 'boolean');
    assert.ok(codes(r.errors).includes('NO_ROOMS_IN_POOL'));
    assert.equal(r.stats.term_weeks, null);
  }
});

// ---- OFFERING_NO_FACULTY
test('OFFERING_NO_FACULTY: pass', () => assert.deepEqual(R.offeringNoFaculty(baseState()), []));
test('OFFERING_NO_FACULTY: fail (no rows)', () => {
  const s = baseState();
  s.offerings[0].faculty = [];
  const [i] = R.offeringNoFaculty(s);
  assert.equal(i.code, 'OFFERING_NO_FACULTY');
  assert.equal(i.severity, 'error');
  assert.deepEqual(i.entity, { type: 'offering', id: 'o-ds', tab: 'offerings' });
  assert.match(i.message, /Data Structures/);
  assert.match(i.message, /CSE-A/);
});
test('OFFERING_NO_FACULTY: fail (some lab batches uncovered)', () => {
  const s = baseState();
  s.offerings[1].faculty = [{ batch_id: 'd1-A1', faculty_id: 'f2', role: 'lead' }];
  const [i] = R.offeringNoFaculty(s);
  assert.deepEqual(i.meta.batches, ['A2', 'A3']);
  assert.match(i.message, /A2, A3/);
});

// ---- DIVISION_NO_OFFERINGS
test('DIVISION_NO_OFFERINGS: pass', () => assert.deepEqual(R.divisionNoOfferings(baseState()), []));
test('DIVISION_NO_OFFERINGS: fail', () => {
  const s = baseState();
  s.divisions.push({ id: 'd2', semester: 3, name: 'CSE-B', student_count: 60, batches: makeBatches('d2', [], 0, 60) });
  const [i] = R.divisionNoOfferings(s);
  assert.equal(i.code, 'DIVISION_NO_OFFERINGS');
  assert.equal(i.severity, 'error');
  assert.equal(i.entity.id, 'd2');
  assert.match(i.message, /CSE-B/);
});

// ---- SUBJECT_UNUSED
test('SUBJECT_UNUSED: pass', () => assert.deepEqual(R.subjectUnused(baseState()), []));
test('SUBJECT_UNUSED: fail', () => {
  const s = baseState();
  s.subjects.push({ id: 's-x', code: 'XX', name: 'Extra', kind: 'theory', duration_min: 60, weekly_count: 1 });
  const [i] = R.subjectUnused(s);
  assert.equal(i.severity, 'warning');
  assert.deepEqual(i.entity, { type: 'subject', id: 's-x', tab: 'subjects' });
});

// ---- NO_ROOMS_IN_POOL
test('NO_ROOMS_IN_POOL: pass', () => assert.deepEqual(R.noRoomsInPool(baseState()), []));
test('NO_ROOMS_IN_POOL: fail', () => {
  const s = baseState();
  s.rooms = [];
  const [i] = R.noRoomsInPool(s);
  assert.equal(i.severity, 'error');
  assert.equal(i.entity.tab, 'rooms');
});

// ---- NO_LAB_ROOM
test('NO_LAB_ROOM: pass', () => assert.deepEqual(R.noLabRoom(baseState()), []));
test('NO_LAB_ROOM: pass when there are no lab offerings', () => {
  const s = baseState();
  s.rooms = s.rooms.filter((r) => !r.is_lab);
  s.offerings = s.offerings.filter((o) => o.id !== 'o-dsl');
  assert.deepEqual(R.noLabRoom(s), []);
});
test('NO_LAB_ROOM: fail', () => {
  const s = baseState();
  s.rooms = s.rooms.filter((r) => !r.is_lab);
  const [i] = R.noLabRoom(s);
  assert.equal(i.code, 'NO_LAB_ROOM');
  assert.equal(i.severity, 'error');
});

// ---- LAB_ROOMS_INSUFFICIENT
test('LAB_ROOMS_INSUFFICIENT: pass', () => assert.deepEqual(R.labRoomsInsufficient(baseState()), []));
test('LAB_ROOMS_INSUFFICIENT: fail', () => {
  const s = baseState();
  s.rooms = s.rooms.filter((r) => r.id !== 'tr-4');
  const [i] = R.labRoomsInsufficient(s);
  assert.equal(i.severity, 'warning');
  assert.equal(i.meta.lab_rooms, 2);
  assert.equal(i.meta.largest_batch_count, 3);
});

// ---- ROOM_TOO_SMALL
test('ROOM_TOO_SMALL: pass', () => assert.deepEqual(R.roomTooSmall(baseState()), []));
test('ROOM_TOO_SMALL: pass when a candidate room has unknown capacity', () => {
  const s = baseState();
  s.divisions[0].student_count = 500;
  s.divisions[0].batches[0].student_count = 500;
  s.rooms[0].capacity = null;
  assert.deepEqual(R.roomTooSmall(s), []);
});
test('ROOM_TOO_SMALL: fail for the division (theory)', () => {
  const s = baseState();
  s.divisions[0].student_count = 100;
  s.divisions[0].batches[0].student_count = 100;
  const out = R.roomTooSmall(s);
  assert.equal(out.length, 1);
  assert.equal(out[0].meta.kind, 'theory');
  assert.equal(out[0].severity, 'warning');
  assert.equal(out[0].entity.id, 'd1');
});
test('ROOM_TOO_SMALL: fail for a lab batch', () => {
  const s = baseState();
  s.divisions[0].batches.filter((b) => !b.is_whole).forEach((b) => (b.student_count = 45));
  const out = R.roomTooSmall(s);
  assert.equal(out.length, 1);
  assert.equal(out[0].meta.kind, 'lab');
  assert.equal(out[0].meta.batch, 'A1');
});

// ---- ROOM_CAPACITY_UNKNOWN
test('ROOM_CAPACITY_UNKNOWN: pass', () => assert.deepEqual(R.roomCapacityUnknown(baseState()), []));
test('ROOM_CAPACITY_UNKNOWN: info, not error', () => {
  const s = baseState();
  s.rooms[0].capacity = null;
  const [i] = R.roomCapacityUnknown(s);
  assert.equal(i.severity, 'info');
  assert.deepEqual(i.entity, { type: 'room', id: 'tr-1', tab: 'rooms' });
  assert.equal(i.meta.room_id, 'room-1');
  const r = computeReadiness(s);
  assert.equal(r.ready, true);
  assert.equal(r.counts.info, 1);
});

// ---- HOME_ROOM_NOT_IN_POOL
test('HOME_ROOM_NOT_IN_POOL: pass (and null home room is fine)', () => {
  assert.deepEqual(R.homeRoomNotInPool(baseState()), []);
  const s = baseState();
  s.divisions[0].home_room_id = null;
  assert.deepEqual(R.homeRoomNotInPool(s), []);
});
test('HOME_ROOM_NOT_IN_POOL: fail (an ERROR when no home room of the division is usable, a warning when another one is)', () => {
  const s = baseState();
  s.divisions[0].home_room_id = 'room-99';
  const [i] = R.homeRoomNotInPool(s);
  assert.equal(i.severity, 'error');
  assert.equal(i.entity.type, 'division');
  assert.equal(computeReadiness(s).ready, false);
  // a second home room that is in the pool keeps the division placeable: only a warning
  const t = baseState();
  const inPool = t.rooms.find((r) => !r.is_lab).room_id;
  t.divisions[0].home_room_ids = ['room-99', inPool];
  const [j] = R.homeRoomNotInPool(t);
  assert.equal(j.severity, 'warning');
});

test('HOME_ROOM_IS_LAB / NO_HOME_ROOM / NO_BUILDING (contract 10)', () => {
  const s = baseState();
  const lab = s.rooms.find((r) => r.is_lab);
  s.divisions[0].home_room_id = lab.room_id;
  const [l] = R.homeRoomIsLab(s);
  assert.equal(l.severity, 'error');
  s.divisions.forEach((d) => { d.home_room_id = null; });
  const [n] = R.noHomeRoom(s);
  assert.equal(n.severity, 'warning');
  assert.equal(n.entity.tab, 'divisions');
  assert.deepEqual(R.noBuilding({ ...s, term: { ...s.term, building_id: 'b1' } }), []);
  assert.deepEqual(R.noBuilding(s), [], 'no building field at all (older state): not reported');
  const [b] = R.noBuilding({ ...s, term: { ...s.term, building_id: null } });
  assert.equal(b.severity, 'warning');
  assert.equal(b.entity.tab, 'settings');
});

// ---- FACULTY_WEEKLY_OVERLOAD
test('FACULTY_WEEKLY_OVERLOAD: pass (exactly at the limit)', () => {
  const s = baseState();
  s.faculty[0].max_per_week = 4;
  assert.deepEqual(R.facultyWeeklyOverload(s), []);
});
test('FACULTY_WEEKLY_OVERLOAD: null limit is skipped', () => {
  const s = baseState();
  s.faculty[0].max_per_week = null;
  assert.deepEqual(R.facultyWeeklyOverload(s), []);
});
test('FACULTY_WEEKLY_OVERLOAD: fail', () => {
  const s = baseState();
  s.faculty[0].max_per_week = 3;
  const [i] = R.facultyWeeklyOverload(s);
  assert.equal(i.severity, 'error');
  assert.equal(i.message, 'Prof. Sharma has 4 sessions per week but the weekly limit is 3.');
  assert.deepEqual(i.entity, { type: 'faculty', id: 'f1', tab: 'faculty' });
});
test('FACULTY_WEEKLY_OVERLOAD: assist rows count towards the load', () => {
  const s = baseState();
  s.offerings[1].faculty.push({ batch_id: null, faculty_id: 'f1', role: 'assist' });
  // f1: 4 theory + 3 lab sessions (assist on every batch)
  s.faculty[0].max_per_week = 6;
  const [i] = R.facultyWeeklyOverload(s);
  assert.equal(i.meta.sessions, 7);
});

// ---- FACULTY_DAILY_CAP_INFEASIBLE
test('FACULTY_DAILY_CAP_INFEASIBLE: pass', () => {
  const s = baseState();
  s.faculty[0].max_per_day = 1; // 1 x 5 days >= 4
  assert.deepEqual(R.facultyDailyCapInfeasible(s), []);
});
test('FACULTY_DAILY_CAP_INFEASIBLE: null limit is skipped', () => {
  const s = baseState();
  s.faculty[0].max_per_day = null;
  assert.deepEqual(R.facultyDailyCapInfeasible(s), []);
});
test('FACULTY_DAILY_CAP_INFEASIBLE: fail', () => {
  const s = baseState();
  s.term.working_days = [0, 1]; // 2 days x 1 = 2 < 4
  s.faculty[0].max_per_day = 1;
  const [i] = R.facultyDailyCapInfeasible(s);
  assert.equal(i.severity, 'error');
  assert.equal(i.meta.working_days, 2);
  assert.match(i.message, /Prof\. Sharma/);
});

// ---- DIVISION_HOURS_OVER_CAPACITY
test('DIVISION_HOURS_OVER_CAPACITY: pass at exactly 40h (labs counted once, not per batch)', () => {
  const s = baseState();
  s.offerings[0].weekly_count = 38; // 38h theory + 2h lab (one batch's lab) = 40h
  assert.deepEqual(R.divisionHoursOverCapacity(s), []);
});
test('DIVISION_HOURS_OVER_CAPACITY: fail', () => {
  const s = baseState();
  s.offerings[0].weekly_count = 39; // 41h
  const [i] = R.divisionHoursOverCapacity(s);
  assert.equal(i.severity, 'error');
  assert.equal(i.meta.required_minutes, 41 * 60);
  assert.equal(i.meta.capacity_minutes, 2400);
  assert.match(i.message, /41 hours/);
  assert.match(i.message, /40 teachable hours/);
});
test('DIVISION_HOURS_OVER_CAPACITY: uses the busiest batch', () => {
  const s = baseState();
  s.offerings[0].weekly_count = 36; // 36h common
  s.offerings.push({ id: 'o-x', division_id: 'd1', subject_id: 's-dsl', weekly_count: 3, per_batch: true, faculty: [{ batch_id: null, faculty_id: 'f2', role: 'lead' }] });
  // lab on every batch: (1 + 3) x 2h = 8h per batch -> 44h > 40h
  const [i] = R.divisionHoursOverCapacity(s);
  assert.equal(i.meta.required_minutes, 44 * 60);
});
test('DIVISION_HOURS_OVER_CAPACITY: fewer working days lower the capacity', () => {
  const s = baseState();
  s.term.working_days = [0]; // 8 teachable hours per week
  assert.deepEqual(R.divisionHoursOverCapacity(s), []); // 4h theory + 2h lab = 6h
  s.offerings[0].weekly_count = 8; // 10h
  const [i] = R.divisionHoursOverCapacity(s);
  assert.equal(i.meta.capacity_minutes, 480);
});

// ---- SEMESTER_TOTAL_MISMATCH
test('SEMESTER_TOTAL_MISMATCH: pass', () => assert.deepEqual(R.semesterTotalMismatch(baseState()), []));
test('SEMESTER_TOTAL_MISMATCH: fail', () => {
  const s = baseState();
  s.subjects[0].semester_total = 50;
  const [i] = R.semesterTotalMismatch(s);
  assert.equal(i.severity, 'warning');
  assert.equal(i.meta.expected, 60);
  assert.equal(i.entity.type, 'offering');
});
test('SEMESTER_TOTAL_MISMATCH: uses the offering override of weekly count', () => {
  const s = baseState();
  s.offerings[0].weekly_count = 2;
  assert.equal(R.semesterTotalMismatch(s)[0].meta.expected, 30);
});
test('SEMESTER_TOTAL_MISMATCH: skipped without dates or without a total', () => {
  const s = baseState();
  s.subjects[0].semester_total = 50;
  s.term.start_date = null;
  assert.deepEqual(R.semesterTotalMismatch(s), []);
  const t = baseState();
  t.subjects.forEach((x) => (x.semester_total = null));
  assert.deepEqual(R.semesterTotalMismatch(t), []);
});

// ---- FACULTY_NOT_LINKED
test('FACULTY_NOT_LINKED: pass', () => assert.deepEqual(R.facultyNotLinked(baseState()), []));
test('FACULTY_NOT_LINKED: fail (info)', () => {
  const s = baseState();
  s.faculty[1].profile_id = null;
  const [i] = R.facultyNotLinked(s);
  assert.equal(i.severity, 'info');
  assert.equal(i.entity.id, 'f2');
});

// ---- LAB_KIND_MISMATCH
test('LAB_KIND_MISMATCH: pass', () => assert.deepEqual(R.labKindMismatch(baseState()), []));
test('LAB_KIND_MISMATCH: lab with per_batch=false', () => {
  const s = baseState();
  s.offerings[1].per_batch = false;
  const [i] = R.labKindMismatch(s);
  assert.equal(i.severity, 'warning');
  assert.equal(i.entity.id, 'o-dsl');
});
test('LAB_KIND_MISMATCH: theory with per_batch=true', () => {
  const s = baseState();
  s.offerings[0].per_batch = true;
  const [i] = R.labKindMismatch(s);
  assert.equal(i.entity.id, 'o-ds');
});

// ---- LAB_NO_BATCHES
test('LAB_NO_BATCHES: pass', () => assert.deepEqual(R.labNoBatches(baseState()), []));
test('LAB_NO_BATCHES: fail', () => {
  const s = baseState();
  s.divisions[0].batches = makeBatches('d1', [], 0, 60);
  const [i] = R.labNoBatches(s);
  assert.equal(i.severity, 'warning');
  assert.equal(i.entity.id, 'o-dsl');
});

// ---- NO_DATES
test('NO_DATES: pass', () => assert.deepEqual(R.noDates(baseState()), []));
test('NO_DATES: fail (info) and week checks are skipped', () => {
  const s = baseState();
  s.term.start_date = null;
  s.subjects[0].semester_total = 1;
  const [i] = R.noDates(s);
  assert.equal(i.severity, 'info');
  assert.equal(i.entity.tab, 'settings');
  const r = computeReadiness(s);
  assert.equal(r.ready, true);
  assert.equal(r.stats.term_weeks, null);
  assert.ok(!codes(r.warnings).includes('SEMESTER_TOTAL_MISMATCH'));
});

// ---- nulls
test('null max_per_*, capacity and missing dates never throw', () => {
  const s = baseState();
  s.faculty.forEach((f) => ((f.max_per_day = null), (f.max_per_week = null)));
  s.rooms.forEach((r) => (r.capacity = null));
  s.term.start_date = null;
  s.term.end_date = null;
  const r = computeReadiness(s);
  assert.equal(r.ready, true);
  assert.deepEqual(codes(r.info).sort(), ['NO_DATES', 'ROOM_CAPACITY_UNKNOWN', 'ROOM_CAPACITY_UNKNOWN', 'ROOM_CAPACITY_UNKNOWN', 'ROOM_CAPACITY_UNKNOWN']);
});

// ---- report shape
test('report: ready is false exactly when there are errors; warnings alone stay ready', () => {
  const s = baseState();
  s.subjects.push({ id: 's-x', code: 'XX', name: 'Extra', kind: 'theory', duration_min: 60, weekly_count: 1 });
  let r = computeReadiness(s);
  assert.equal(r.ready, true);
  assert.equal(r.counts.warnings, 1);
  s.rooms = [];
  r = computeReadiness(s);
  assert.equal(r.ready, false);
  assert.ok(r.counts.errors >= 1);
  assert.equal(r.counts.errors, r.errors.length);
});

// ---- the realistic semester fixture
test('semester fixture is ready (only info/warnings)', () => {
  const r = computeReadiness(buildSemesterState());
  assert.equal(r.ready, true);
  assert.equal(r.counts.errors, 0);
  assert.equal(r.stats.divisions, 15);
  assert.equal(r.stats.subjects, 8);
  assert.equal(r.stats.faculty_assigned, 12);
  assert.equal(r.stats.lab_rooms, 4);
  assert.equal(r.stats.sessions_required, 230);
});

test('semester fixture also works for other division counts', () => {
  for (const n of [1, 3, 6]) assert.equal(computeReadiness(buildSemesterState({ divisions: n })).ready, true, String(n));
});

const perturbations = {
  OFFERING_NO_FACULTY: (s) => (s.offerings[0].faculty = []),
  NO_DIVISIONS: (s) => ((s.divisions = []), (s.offerings = [])),
  DIVISION_NO_OFFERINGS: (s) => s.divisions.push({ id: 'dz', semester: 3, name: 'Z', student_count: 10, batches: makeBatches('dz', [], 0, 10) }),
  NO_ROOMS_IN_POOL: (s) => (s.rooms = []),
  NO_LAB_ROOM: (s) => (s.rooms = s.rooms.filter((r) => !r.is_lab)),
  FACULTY_WEEKLY_OVERLOAD: (s) => (s.faculty[0].max_per_week = 1),
  FACULTY_DAILY_CAP_INFEASIBLE: (s) => ((s.faculty[0].max_per_day = 1), (s.term.working_days = [0])),
  DIVISION_HOURS_OVER_CAPACITY: (s) => (s.offerings[0].weekly_count = 60),
};
for (const [code, fn] of Object.entries(perturbations)) {
  test(`semester fixture perturbed -> ${code}`, () => {
    const s = clone(buildSemesterState());
    fn(s);
    const r = computeReadiness(s);
    assert.equal(r.ready, false);
    assert.ok(codes(r.errors).includes(code), `${code} missing in ${codes(r.errors)}`);
  });
}

const warnPerturbations = {
  SUBJECT_UNUSED: (s) => s.subjects.push({ id: 'sx', code: 'XX', name: 'Extra', kind: 'theory', duration_min: 60, weekly_count: 1 }),
  LAB_ROOMS_INSUFFICIENT: (s) => (s.rooms = s.rooms.filter((r) => !r.is_lab).concat(s.rooms.filter((r) => r.is_lab).slice(0, 2))),
  NO_CLASSROOM_ROOM: (s) => { s.rooms = s.rooms.filter((r) => r.is_lab); s.divisions.forEach((d) => { d.home_room_id = null; }); },
  SEMESTER_TOTAL_MISMATCH: (s) => (s.subjects[0].semester_total = 1),
  LAB_KIND_MISMATCH: (s) => {
    const o = s.offerings.find((x) => x.per_batch);
    o.per_batch = false;
    o.faculty = [{ batch_id: null, faculty_id: o.faculty[0].faculty_id, role: 'lead' }];
  },
  LAB_NO_BATCHES: (s) => {
    const o = s.offerings.find((x) => x.per_batch);
    const d = s.divisions.find((x) => x.id === o.division_id);
    d.batches = d.batches.filter((b) => b.is_whole);
    o.faculty = [{ batch_id: null, faculty_id: o.faculty[0].faculty_id, role: 'lead' }];
  },
};
for (const [code, fn] of Object.entries(warnPerturbations)) {
  test(`semester fixture perturbed -> ${code} (warning, still ready)`, () => {
    const s = clone(buildSemesterState());
    fn(s);
    const r = computeReadiness(s);
    assert.ok(codes(r.warnings).includes(code), `${code} missing in ${codes(r.warnings)}`);
    assert.equal(r.ready, true);
  });
}
