import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, combinePatternStats, comparisonRows } from './lib/metrics.mjs';
import { checkIntegrity, peakLoad, conflictsAgainst, buildCtx } from './lib/integrity.mjs';
import { renderReport } from './lib/report.mjs';
import { readJson, SKIP_REAL } from './lib/fixtures.mjs';
import { mini, sessionOf, roomId, placeIn } from './lib/testkit.mjs';

const MON = 0;
const TUE = 1;
const WED = 2;
const THU = 3;

function base() {
  return mini({
    rooms: [{ name: 'C1', cap: 60 }, { name: 'LAB', lab: true, cap: 62 }],
    faculty: ['A', 'B', 'C', 'D'],
    subjects: [{ code: 'T1', kind: 'theory', weekly: 3 }, { code: 'T2', kind: 'theory', weekly: 1 }, { code: 'L1', kind: 'lab', weekly: 1 }, { code: 'L2', kind: 'lab', weekly: 1 }],
    divisions: [{ name: 'X', students: 40, batches: [['X1', 20], ['X2', 20]], home: 'C1' }],
    offerings: [{ div: 'X', code: 'T1', faculty: 'A' }, { div: 'X', code: 'T2', faculty: 'B' }, { div: 'X', code: 'L1', faculty: 'C' }, { div: 'X', code: 'L2', faculty: 'D' }],
  });
}

function placed() {
  const w = base();
  const C1 = roomId(w, 'C1');
  const LAB = roomId(w, 'LAB');
  placeIn(w, sessionOf(w, 'X', 'T1', 'ALL', 1), MON, 510, C1);
  placeIn(w, sessionOf(w, 'X', 'T1', 'ALL', 2), MON, 570, C1);
  placeIn(w, sessionOf(w, 'X', 'T1', 'ALL', 3), WED, 645, C1);
  placeIn(w, sessionOf(w, 'X', 'T2', 'ALL', 1), MON, 645, C1);
  placeIn(w, sessionOf(w, 'X', 'L1', 'X1'), TUE, 810, LAB);
  placeIn(w, sessionOf(w, 'X', 'L2', 'X2'), TUE, 810, LAB);
  placeIn(w, sessionOf(w, 'X', 'L2', 'X1'), THU, 945, LAB);
  placeIn(w, sessionOf(w, 'X', 'L1', 'X2'), THU, 945, LAB);
  return w;
}

test('metrics: counts, histograms, units and shares follow the pattern_stats definitions', () => {
  const m = computeMetrics(placed());
  const c = m.combined;
  assert.deepEqual([c.panels, c.theory_slots, c.lab_blocks, c.units], [1, 4, 2, 6]);
  assert.deepEqual(c.theory_slot_start_histogram, { '08:30': 1, '09:30': 1, '10:45': 2 });
  assert.deepEqual(c.lab_block_start_histogram, { '13:30': 1, '15:45': 1 });
  assert.equal(c.avg_theory_slots_plus_lab_blocks_per_panel_per_day_overall, 1.2);
  assert.equal(c.share_theory_slots_starting_at_or_after_15_45, 0);
  assert.equal(c.share_lab_blocks_starting_at_or_after_15_45, 0.5);
  assert.equal(c.share_all_cells_starting_at_or_after_15_45, 0.167);
  assert.deepEqual(c.lab_block_parallel_batch_entries_histogram, { 2: 2 });
  assert.deepEqual(c.theory_slots_per_weekday, { Mon: 3, Tue: 0, Wed: 1, Thu: 0, Fri: 0 });
  assert.deepEqual(m.placement, { total: 8, placed: 8, unplaced: 0, placed_pct: 100, unplaced_by_kind: { theory: 0, lab: 0 }, unplaced_by_reason: {} });
});

test('metrics: same-subject-twice-a-day is split into back to back and split', () => {
  const m = computeMetrics(placed());
  assert.equal(m.combined.subject_spread.same_day_repeat_back_to_back, 1);
  assert.equal(m.combined.subject_spread.same_day_repeat_split, 0);
  assert.equal(m.combined.subject_spread.subject_slots_all_on_different_days, 0);
  const w = placed();
  placeIn(w, sessionOf(w, 'X', 'T1', 'ALL', 2), MON, 810, roomId(w, 'C1')); // 13:30: same day as #1 but not adjacent
  const m2 = computeMetrics(w);
  assert.equal(m2.combined.subject_spread.same_day_repeat_split, 1);
  assert.equal(m2.combined.subject_spread.same_day_repeat_back_to_back, 0);
});

test('metrics: lab rotation and parallel lab blocks', () => {
  const r = computeMetrics(placed()).combined.lab_rotation;
  assert.deepEqual(r, { panels_with_lab_rotation: 1, every_batch_meets_every_lab_subject: 1, exactly_once_each: 1, lab_blocks_with_2plus_parallel_batches: 2, of_which_every_batch_on_a_different_subject: 2 });
});

test('metrics: per-division hours, longest run, idle gaps', () => {
  const m = computeMetrics(placed());
  const d = m.per_division[0];
  assert.deepEqual(d.hours_per_day, { Mon: 3, Tue: 2, Wed: 1, Thu: 2, Fri: 0 });
  assert.equal(d.longest_run_h, 3);
  assert.equal(d.idle_gap_days, 0);
  assert.deepEqual(d.units_per_day, { Mon: 3, Tue: 1, Wed: 1, Thu: 1, Fri: 0 });
  assert.equal(m.division_days.days_with_run_over_3h, 0);
  const w = placed();
  placeIn(w, sessionOf(w, 'X', 'T2', 'ALL', 1), MON, 810, roomId(w, 'C1')); // leaves 10:45-13:30 empty on Monday
  const m2 = computeMetrics(w);
  assert.equal(m2.per_division[0].idle_gap_days, 1);
  assert.equal(m2.per_division[0].idle_hours, 2); // 10:30-13:30 minus the 15 min and 45 min breaks
  assert.equal(m2.division_days.total_idle_hours, 2);
});

test('metrics: a 4 hour run is counted', () => {
  const w = placed();
  placeIn(w, sessionOf(w, 'X', 'T2', 'ALL', 1), MON, 705, roomId(w, 'C1')); // 08:30..12:45 contiguous (4 h)
  placeIn(w, sessionOf(w, 'X', 'T1', 'ALL', 3), MON, 645, roomId(w, 'C1'));
  const m = computeMetrics(w);
  assert.equal(m.division_days.days_with_run_over_3h, 1);
  assert.equal(m.per_division[0].longest_run_h, 4);
});

test('metrics: lab rules per batch per day', () => {
  const w = placed();
  placeIn(w, sessionOf(w, 'X', 'L2', 'X1'), TUE, 945, roomId(w, 'LAB')); // X1 now has L1 and L2 on Tuesday
  placeIn(w, sessionOf(w, 'X', 'L1', 'X2'), WED, 810, roomId(w, 'LAB'));
  const m = computeMetrics(w);
  assert.equal(m.lab_rules.batch_days_with_more_than_one_lab_session, 1);
  assert.equal(m.lab_rules.batch_days_with_two_different_lab_subjects, 1);
  assert.equal(computeMetrics(placed()).lab_rules.batch_days_with_more_than_one_lab_session, 0);
});

test('metrics: teachers, rooms, shared labs', () => {
  const m = computeMetrics(placed());
  const a = m.teachers.all.find((t) => t.faculty === 'A');
  assert.deepEqual([a.weekly_hours, a.max_day_h, a.min_day_h, a.longest_run_h], [3, 2, 0, 2]);
  assert.equal(m.teachers.count_teaching, 4);
  const rc = m.rooms.classrooms;
  assert.deepEqual([rc.used, rc.total_hours, rc.theory_sessions_in_division_home_room, rc.home_room_share], [1, 4, 4, 1]);
  const rl = m.rooms.lab_rooms;
  assert.deepEqual([rl.used, rl.session_hours, rl.room_hours_with_two_or_more_groups, rl.peak_shared_students], [1, 8, 4, 40]);
  assert.deepEqual(rl.rooms_over_capacity, []);
});

test('metrics: unplaced sessions are listed with their reasons and teachers', { skip: SKIP_REAL }, () => {
  const w = placed();
  const t2 = sessionOf(w, 'X', 'T2', 'ALL', 1);
  Object.assign(t2, { weekday: null, start_min: null, end_min: null, room_id: null });
  const m = computeMetrics(w, { unplaced: [{ session_id: t2.id, code: 'FACULTY_BUSY', text: 'teacher B is busy' }], rejections: [{ code: 'CLASH' }, { code: 'CLASH' }, { code: 'NO_ROOM_AVAILABLE' }] });
  assert.equal(m.placement.unplaced, 1);
  assert.deepEqual(m.placement.unplaced_by_reason, { FACULTY_BUSY: 1 });
  assert.deepEqual(m.rejections_by_code, { CLASH: 2, NO_ROOM_AVAILABLE: 1 });
  assert.deepEqual(m.unplaced_sessions[0], { session_id: t2.id, division: '3|X', subject: 'T2', kind: 'theory', batch: 'ALL', seq: 1, teachers: ['B'], reason_code: 'FACULTY_BUSY', reason: 'teacher B is busy' });
  assert.equal(computeMetrics(w).unplaced_sessions[0].reason_code, 'UNKNOWN_NO_RUN_LOG');
  const md = renderReport({ metrics: m, patternStats: readJson('pattern_stats.json') });
  assert.match(md, /Unplaced sessions/);
  assert.match(md, /FACULTY_BUSY/);
});

// ---- integrity -------------------------------------------------------------------------------

test('integrity: a clean timetable passes', () => {
  const r = checkIntegrity(placed());
  assert.deepEqual([r.ok, r.violations.length], [true, 0]);
  assert.equal(r.checked.placed, 8);
});

test('integrity: batch, room and faculty clashes are found from the snapshot alone', () => {
  const w = placed();
  const C1 = roomId(w, 'C1');
  // second lecture at the same time as T1#1 in the same classroom for the same students
  placeIn(w, sessionOf(w, 'X', 'T2', 'ALL', 1), MON, 510, C1);
  const r = checkIntegrity(w);
  const types = r.violations.map((v) => v.type).sort();
  assert.ok(types.includes('BATCH_CLASH') && types.includes('ROOM_CLASH'));
  assert.equal(r.ok, false);

  // two divisions sharing one teacher
  const two = mini({
    rooms: [{ name: 'C1', cap: 60 }, { name: 'C2', cap: 60 }],
    faculty: ['A'],
    subjects: [{ code: 'T1', kind: 'theory', weekly: 1 }],
    divisions: [{ name: 'X', students: 60, home: 'C1' }, { name: 'Y', students: 60, home: 'C2' }],
    offerings: [{ div: 'X', code: 'T1', faculty: 'A' }, { div: 'Y', code: 'T1', faculty: 'A' }],
  });
  placeIn(two, sessionOf(two, 'X', 'T1'), MON, 510, roomId(two, 'C1'));
  placeIn(two, sessionOf(two, 'Y', 'T1'), MON, 570, roomId(two, 'C2')); // 09:30: no overlap yet
  assert.equal(checkIntegrity(two).ok, true);
  placeIn(two, sessionOf(two, 'Y', 'T1'), MON, 540, roomId(two, 'C2')); // 09:00-10:00 overlaps 08:30-09:30
  const r2 = checkIntegrity(two);
  assert.deepEqual(r2.violations.map((v) => v.type), ['FACULTY_CLASH']);
});

test('integrity: shared lab capacity (peak <= capacity), exclusive classrooms, theory in a lab room', () => {
  const w = mini({
    rooms: [{ name: 'LAB32', lab: true, cap: 32 }, { name: 'LAB62', lab: true, cap: 62 }],
    faculty: ['A', 'B', 'C', 'D'],
    subjects: [{ code: 'L1', kind: 'lab', weekly: 1 }, { code: 'T1', kind: 'theory', weekly: 1 }],
    divisions: [{ name: 'P', students: 60, batches: [['P1', 20], ['P2', 20], ['P3', 20]] }, { name: 'Q', students: 20 }],
    offerings: [{ div: 'P', code: 'L1', faculty: 'A', batch: 'P1' }, { div: 'P', code: 'L1', faculty: 'B', batch: 'P2' }, { div: 'P', code: 'L1', faculty: 'C', batch: 'P3' }, { div: 'Q', code: 'T1', faculty: 'D' }],
  });
  const l32 = roomId(w, 'LAB32');
  const l62 = roomId(w, 'LAB62');
  for (const b of ['P1', 'P2', 'P3']) placeIn(w, sessionOf(w, 'P', 'L1', b), MON, 510, l62);
  assert.equal(checkIntegrity(w).ok, true, '60 students in a 62 seater');
  for (const b of ['P1', 'P2']) placeIn(w, sessionOf(w, 'P', 'L1', b), MON, 510, l32);
  const cap = checkIntegrity(w);
  assert.equal(cap.ok, false);
  assert.deepEqual(cap.violations.map((v) => v.type), ['ROOM_CAPACITY'], 'P1 + P2 = 40 students in a 32 seater');
  // a lecture (exclusive) inside a lab room that already hosts a shared lab session is a room clash
  placeIn(w, sessionOf(w, 'Q', 'T1'), MON, 510, l32);
  assert.ok(checkIntegrity(w).violations.some((v) => v.type === 'ROOM_CLASH'));
});

test('integrity: peakLoad sweep, half-open intervals', () => {
  assert.equal(peakLoad([{ start: 0, end: 60, students: 20 }, { start: 60, end: 120, students: 30 }]), 30);
  assert.equal(peakLoad([{ start: 0, end: 61, students: 20 }, { start: 60, end: 120, students: 30 }]), 50);
  assert.equal(peakLoad([]), 0);
});

test('integrity: conflictsAgainst honours shared labs and the pre-8.7 switch', () => {
  const w = mini({
    rooms: [{ name: 'LAB62', lab: true, cap: 62 }],
    faculty: ['A', 'B'],
    subjects: [{ code: 'L1', kind: 'lab', weekly: 1 }],
    divisions: [{ name: 'P', students: 40, batches: [['P1', 20], ['P2', 20]] }],
    offerings: [{ div: 'P', code: 'L1', faculty: 'A', batch: 'P1' }, { div: 'P', code: 'L1', faculty: 'B', batch: 'P2' }],
  });
  const lab = roomId(w, 'LAB62');
  const p1 = placeIn(w, sessionOf(w, 'P', 'L1', 'P1'), MON, 510, lab);
  const p2 = { ...sessionOf(w, 'P', 'L1', 'P2'), weekday: MON, start_min: 510, end_min: 630, room_id: lab };
  const ctx = buildCtx(w);
  assert.deepEqual(conflictsAgainst(ctx, [p1], p2).map((c) => c.kind), []);
  assert.deepEqual(conflictsAgainst(ctx, [p1], p2, { sharedLabs: false }).map((c) => c.kind), ['room']);
});

// ---- comparison with pattern_stats.json ---------------------------------------------------------

test('comparison: pattern_stats.json is combined over both semesters and lined up with our metrics', { skip: SKIP_REAL }, () => {
  const admin = combinePatternStats(readJson('pattern_stats.json'));
  assert.equal(admin.panels, 40);
  assert.ok(admin.theory_slots > 500 && admin.lab_blocks > 150);
  assert.ok(admin.share_all_cells_starting_at_or_after_15_45 > 0 && admin.share_all_cells_starting_at_or_after_15_45 < 0.1);
  const rows = comparisonRows(computeMetrics(placed()), admin);
  assert.ok(rows.length >= 12);
  assert.ok(rows.every((r) => r.metric && 'ours' in r && 'admin' in r));
});
