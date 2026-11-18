import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEngineConfig, defaultEngineConfig, BASE_WEIGHTS, PARAM_DEFAULTS, OccupancyModel, theoryCandidates, labBlockCandidates } from '../../../services/planner/engine/index.js';
import { DEFAULT_RULES } from '../../../services/planner/domain/index.js';
import { mini, sessionOf, placeIn, roomId } from '../real/lib/testkit.mjs';

const rule = (rule_key, patch = {}) => ({ rule_key, enabled: true, severity: 'soft', weight: 1, params: {}, ...patch });

test('config: DEFAULT_RULES, an empty list and null all give the default config', () => {
  const d = defaultEngineConfig();
  assert.deepEqual(buildEngineConfig(DEFAULT_RULES), d);
  assert.deepEqual(buildEngineConfig([]), d);
  assert.deepEqual(buildEngineConfig(null), d);
  assert.equal(d.weights.runFaculty, 10);
  assert.equal(d.defaults.facultyDefaultMaxHours, 6);
  assert.deepEqual(d.hard, {
    labPerDayMax: 1, subjectPerDayMax: 1, facultyRunHours: null, divisionRunHours: null, divisionDayHours: null, facultyDayHours: null, divisionIdleGapMinutes: 0, theoryCoreWindow: null,
  });
});

test('config: the frozen 9.2 params are used when the stored row has none (4 new keys absent from the stored rows)', () => {
  const c = buildEngineConfig([rule('faculty_daily_load'), rule('division_daily_hours'), rule('time_of_day')]);
  assert.equal(c.defaults.facultyDefaultMaxHours, PARAM_DEFAULTS.faculty_daily_load.default_max_hours);
  assert.equal(c.defaults.maxDayHours, 6);
  assert.deepEqual([c.defaults.coreStart, c.defaults.coreEnd, c.defaults.lateStart], [645, 930, 945]);
  assert.deepEqual(c.rules.time_of_day.params, { core_start: 645, core_end: 930, late_start: 945 });
});

test('config: weights multiply, a disabled rule is 0 everywhere, params are honoured', () => {
  const c = buildEngineConfig([
    rule('faculty_consecutive', { weight: 2, params: { n: 2 } }),
    rule('student_consecutive', { enabled: false }),
    rule('student_idle_gap', { weight: 3 }),
    rule('faculty_daily_load', { weight: 0.5, params: { default_max_hours: 5 } }),
    rule('subject_spread', { weight: 4, params: { max_per_day: 2 } }),
    rule('day_balance', { weight: 0 }),
    rule('division_daily_hours', { weight: 2, params: { max_hours: 5 } }),
    rule('time_of_day', { weight: 2, params: { core_start: 600 } }),
    rule('room_change', { weight: 10 }),
    rule('lab_per_day', { params: { max: 2 } }),
  ]);
  const W = c.weights;
  assert.equal(W.runFaculty, 20);
  assert.equal(c.defaults.maxRunFaculty, 2);
  assert.equal(W.runDivision, 0);
  assert.equal(c.defaults.maxRunDivision, 3);
  assert.equal(W.idleHour, 9);
  assert.equal(W.facultyLoad, 0.5);
  assert.equal(W.facultyOverDefault, 4);
  assert.equal(c.defaults.facultyDefaultMaxHours, 5);
  assert.equal(W.sameSubjectNextDay, 6);
  assert.equal(W.sameSubjectSameDay, 24);
  assert.equal(c.hard.subjectPerDayMax, 2);
  assert.equal(W.dayLoad, 0);
  assert.equal(W.dayOverload, 40);
  assert.equal(c.defaults.maxDayHours, 5);
  assert.deepEqual([W.earlyTheory, W.lateTheory, W.veryLateTheory], [6, 24, 8]);
  assert.equal(c.defaults.coreStart, 600);
  assert.equal(W.notHomeRoom, 5);
  assert.equal(c.hard.labPerDayMax, 2);
  assert.deepEqual(W.labStart, BASE_WEIGHTS.labStart, 'lab start preferences are not scaled');
  // disabled: no filter either
  const off = buildEngineConfig([rule('division_daily_hours', { enabled: false }), rule('subject_spread', { enabled: false }), rule('lab_per_day', { enabled: false })]);
  assert.equal(off.defaults.maxDayHours, Infinity);
  assert.equal(off.hard.subjectPerDayMax, Infinity);
  assert.equal(off.hard.labPerDayMax, Infinity);
  assert.equal(off.weights.dayOverload, 0);
});

test('config: only the rules the admin set to hard (and enabled) become filters', () => {
  const c = buildEngineConfig([
    rule('faculty_consecutive', { severity: 'hard', params: { n: 2 } }),
    rule('student_consecutive', { severity: 'hard' }),
    rule('division_daily_hours', { severity: 'hard', params: { max_hours: 5 } }),
    rule('faculty_daily_load', { severity: 'hard', params: { default_max_hours: 4 } }),
    rule('student_idle_gap', { severity: 'hard', params: { max_gap_minutes: 90 } }),
    rule('time_of_day', { severity: 'hard' }),
  ]);
  assert.deepEqual(c.hard, {
    labPerDayMax: 1, subjectPerDayMax: 1, facultyRunHours: 2, divisionRunHours: 3, divisionDayHours: 5, facultyDayHours: 4, divisionIdleGapMinutes: 90, theoryCoreWindow: { start: 645, end: 930 },
  });
  const disabled = buildEngineConfig([rule('faculty_consecutive', { severity: 'hard', enabled: false })]);
  assert.equal(disabled.hard.facultyRunHours, null);
});

// ---- the config actually drives the ranking ------------------------------------------------------------------

const rooms = [{ name: 'C1', cap: 60 }, { name: 'C2', cap: 60 }, { name: 'LAB1', lab: true, cap: 62 }, { name: 'LAB2', lab: true, cap: 62 }];
function world(weekly = 2) {
  return mini({
    rooms,
    faculty: ['A', 'B', 'C', 'D'],
    subjects: [{ code: 'T1', kind: 'theory', weekly }, { code: 'T2', kind: 'theory', weekly: 1 }, { code: 'T3', kind: 'theory', weekly: 1 }, { code: 'T4', kind: 'theory', weekly: 1 }, { code: 'T5', kind: 'theory', weekly: 1 }],
    divisions: [{ name: 'X', students: 60, home: 'C1' }, { name: 'Y', students: 60, home: 'C2' }],
    offerings: [{ div: 'X', code: 'T1', faculty: 'A' }, { div: 'X', code: 'T2', faculty: 'B' }, { div: 'X', code: 'T3', faculty: 'B' }, { div: 'X', code: 'T4', faculty: 'B' }, { div: 'X', code: 'T5', faculty: 'B' }, { div: 'Y', code: 'T1', faculty: 'C' }],
  });
}
function put(m, w, div, code, seq, day, start) {
  const s = sessionOf(w, div, code, 'ALL', seq);
  const e = m.evaluate(s.id, day, start);
  assert.equal(e.ok, true);
  m.place(s.id, day, start, e.end, e.room_id, e.shared);
}

test('rank+config: faculty_daily_load is a penalty (facultyOver), a hard filter only when its severity is hard', () => {
  const w = world();
  const m = new OccupancyModel(w);
  // teacher B already teaches 6 hours on Monday (T2, T3, T4 in X + ... use Y-free slots): 08:30 09:30 10:45 11:45 13:30 14:30
  const extra = mini({
    rooms,
    faculty: ['B', 'A'],
    subjects: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'].map((code) => ({ code, kind: 'theory', weekly: 1 })),
    divisions: [{ name: 'X', students: 60, home: 'C1' }, { name: 'Y', students: 60, home: 'C2' }],
    offerings: [...['T1', 'T2', 'T3', 'T4', 'T5', 'T6'].map((code) => ({ div: 'X', code, faculty: 'B' })), { div: 'Y', code: 'T7', faculty: 'B' }],
  });
  const mm = new OccupancyModel(extra);
  [510, 570, 645, 705, 810, 870].forEach((s, n) => put(mm, extra, 'X', `T${n + 1}`, 1, 0, s));
  const sid = sessionOf(extra, 'Y', 'T7').id;
  const soft = theoryCandidates(mm, sid, { config: buildEngineConfig([]), strict: false });
  const monSoft = soft.find((c) => c.day === 0 && c.start === 945);
  assert.ok(monSoft, 'the 7th hour of the teacher is allowed by default');
  assert.ok(monSoft.parts.facultyOver > 0 && monSoft.parts.facultyOver === 8, 'one hour over the 6 h limit costs 8');
  const tueBest = soft.find((c) => c.day === 1);
  assert.ok(!tueBest.parts.facultyOver);
  assert.ok(soft.find((c) => c.day === 0).score > tueBest.score);
  const hard = theoryCandidates(mm, sid, { config: buildEngineConfig([rule('faculty_daily_load', { severity: 'hard', params: { default_max_hours: 6 } })]), strict: false });
  assert.ok(hard.every((c) => c.day !== 0), 'hard: a 7th hour is a filter');
  const off = theoryCandidates(mm, sid, { config: buildEngineConfig([rule('faculty_daily_load', { enabled: false })]), strict: false });
  assert.ok(off.find((c) => c.day === 0 && c.start === 945).parts.facultyOver === undefined);
  // an explicit max_per_day is a hard filter whatever the rule says, and gets no facultyOver penalty
  extra.faculty.find((f) => f.short_code === 'B').max_per_day = 6;
  const m2 = new OccupancyModel(extra);
  [510, 570, 645, 705, 810, 870].forEach((s, n) => put(m2, extra, 'X', `T${n + 1}`, 1, 0, s));
  assert.ok(theoryCandidates(m2, sid, { config: buildEngineConfig([rule('faculty_daily_load', { enabled: false })]), strict: false }).every((c) => c.day !== 0));
  void m;
});

test('rank+config: subject_spread max_per_day 2 admits a second same-day lecture; the default needs the back-to-back exception', () => {
  const w = world(2);
  const m = new OccupancyModel(w);
  put(m, w, 'X', 'T1', 1, 0, 645);
  const sid = sessionOf(w, 'X', 'T1', 'ALL', 2).id;
  assert.ok(theoryCandidates(m, sid, { config: buildEngineConfig([]), strict: false }).every((c) => c.day !== 0));
  const two = theoryCandidates(m, sid, { config: buildEngineConfig([rule('subject_spread', { params: { max_per_day: 2 } })]), strict: false });
  assert.ok(two.some((c) => c.day === 0));
  const monday = two.filter((c) => c.day === 0);
  assert.ok(monday.every((c) => c.parts.spread >= 6), 'the same-day penalty still applies');
  const off = theoryCandidates(m, sid, { config: buildEngineConfig([rule('subject_spread', { enabled: false })]), strict: false });
  assert.ok(off.some((c) => c.day === 0));
});

test('rank+config: division_daily_hours hard filters the relaxed pass too; lab_per_day max 2 lifts the one-lab-a-day cap', () => {
  const w = mini({
    rooms,
    faculty: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
    subjects: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'].map((code) => ({ code, kind: 'theory', weekly: 1 })),
    divisions: [{ name: 'X', students: 60, home: 'C1' }],
    offerings: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'].map((code, i) => ({ div: 'X', code, faculty: 'ABCDEFG'[i] })),
  });
  const m = new OccupancyModel(w);
  [510, 570, 645, 705, 810, 870].forEach((s, i) => put(m, w, 'X', `T${i + 1}`, 1, 0, s));
  const t7 = sessionOf(w, 'X', 'T7').id;
  assert.ok(theoryCandidates(m, t7, { config: buildEngineConfig([]), strict: false }).some((c) => c.day === 0), 'soft by default: relaxed pass allows a 7th hour');
  assert.ok(theoryCandidates(m, t7, { config: buildEngineConfig([rule('division_daily_hours', { severity: 'hard' })]), strict: false }).every((c) => c.day !== 0));

  const lw = mini({
    rooms,
    faculty: ['A', 'B', 'C', 'D'],
    subjects: [{ code: 'L1', kind: 'lab', weekly: 1 }, { code: 'L2', kind: 'lab', weekly: 1 }],
    divisions: [{ name: 'X', students: 40, batches: [['X1', 20], ['X2', 20]], home: 'C1' }],
    offerings: [{ div: 'X', code: 'L1', faculty: 'A' }, { div: 'X', code: 'L2', faculty: 'B' }],
  });
  const lm = new OccupancyModel(lw);
  const b1 = [sessionOf(lw, 'X', 'L1', 'X1'), sessionOf(lw, 'X', 'L2', 'X2')];
  const t = lm.tryBlock(b1.map((s) => ({ sid: s.id })), 0, 645);
  for (const p of t.plan) lm.place(p.sid, 0, 645, p.end, p.room_id, p.shared);
  const b2 = { key: 'b2', sessions: [sessionOf(lw, 'X', 'L2', 'X1'), sessionOf(lw, 'X', 'L1', 'X2')].map((s) => ({ id: s.id })) };
  assert.ok(labBlockCandidates(lm, b2, { config: buildEngineConfig([]), strict: false }).every((c) => c.day !== 0));
  assert.ok(labBlockCandidates(lm, b2, { config: buildEngineConfig([rule('lab_per_day', { severity: 'hard', params: { max: 2 } })]), strict: false }).some((c) => c.day === 0 && c.start !== 645));
  void placeIn; void roomId;
});

test('rank+config: the default no-idle-time rule only admits slots that touch the division day; soft or limit > 0 admits gaps', () => {
  const w = world();
  const m = new OccupancyModel(w);
  put(m, w, 'X', 'T1', 1, 0, 510); // Monday 08:30-09:30
  const t2 = sessionOf(w, 'X', 'T2').id;
  const starts = (cfg) => theoryCandidates(m, t2, { config: cfg, strict: false }).filter((c) => c.day === 0).map((c) => c.start);
  const hard = starts(buildEngineConfig([]));
  assert.ok(hard.includes(570), 'right after the first lecture is gap-free');
  assert.ok(!hard.includes(945), 'a 15:45 start would leave idle time -> not a candidate');
  assert.ok(hard.every((s) => s <= 570 + 15 || s === 645 || s === 630 || s < 570), 'only slots touching 09:30 (or the break that follows it)');
  const soft = starts(buildEngineConfig([rule('student_idle_gap', { severity: 'soft', params: { max_gap_minutes: 60 } })]));
  assert.ok(soft.includes(945), 'soft: the same slot is only penalised');
  const loose = starts(buildEngineConfig([rule('student_idle_gap', { severity: 'hard', params: { max_gap_minutes: 240 } })]));
  assert.ok(loose.includes(780) || loose.includes(810) || loose.includes(945), 'a limit above 0 admits some idle time');
  // an empty day: the first lecture may start anywhere (the day need not begin at 08:30)
  const t3 = sessionOf(w, 'X', 'T3').id;
  assert.ok(theoryCandidates(m, t3, { config: buildEngineConfig([]), strict: false }).some((c) => c.day === 1 && c.start === 945));
});
