// Engine configuration from the term's rule rows (contract 9.2 "Generator mapping"). Pure.
//
// buildEngineConfig(rules) -> {weights, defaults, hard, rules}
//   rules: [{rule_key, enabled, severity, weight, params}] (partial lists are fine; a missing key falls back to
//   domain/ruleDefaults.js DEFAULT_RULES, and to the frozen 9.2 defaults below for params / the 4 Phase-3 keys).
//
// With the default rules the result reproduces the harness constants of tests/planner/real/lib/rank.mjs
// (WEIGHTS / DEFAULTS) exactly; the only additions are `facultyOverDefault` (8 per hour over the daily limit) and the
// separate run limits maxRunFaculty / maxRunDivision (both 3 = the harness maxRunHours).
//
// Rule weight multiplier m = enabled ? weight : 0, applied to the built-in weights. A disabled rule is off everywhere
// (no penalty, no filter). Blocking and the inherent hard rules (room_type, room_capacity, clashes) live in the model.
import { DEFAULT_RULES } from '../domain/ruleDefaults.js';

/** The harness WEIGHTS (rank.mjs) -- the single source of truth for the engine. */
export const BASE_WEIGHTS = Object.freeze({
  earlyTheory: 3,
  lateTheory: 12,
  veryLateTheory: 4,
  dayLoad: 2.0,
  sameSubjectSameDay: 6,
  sameSubjectNextDay: 1.5,
  runDivision: 15,
  runFaculty: 10,
  idleHour: 3,
  facultyLoad: 1.0,
  notHomeRoom: 0.5,
  nonStandardStart: 5,
  dayOverload: 20,
  labStart: Object.freeze({ 645: 0, 810: 1, 510: 2, 945: 8 }),
  labStartOther: 6,
  labAdjacentDay: 1.5,
  labSameDay: 8,
  jitter: 0.3,
  facultyOverDefault: 8, // NEW (9.2): per hour a faculty member's day exceeds faculty_daily_load.default_max_hours
});

/** Frozen 9.2 params (used when neither the stored row nor DEFAULT_RULES carries them). */
export const PARAM_DEFAULTS = Object.freeze({
  lab_per_day: { max: 1 },
  faculty_daily_load: { default_max_hours: 6 },
  faculty_consecutive: { n: 3 },
  faculty_idle_gap: { max_gap_minutes: 180 },
  student_consecutive: { n: 3 },
  student_idle_gap: { max_gap_minutes: 60 },
  subject_spread: { max_per_day: 1 },
  room_change: { mode: 'any_break', min_break_minutes: null },
  day_balance: { max_spread_hours: 3 },
  division_daily_hours: { max_hours: 6 },
  time_of_day: { core_start: 645, core_end: 930, late_start: 945 },
});

const SEVERITY_DEFAULTS = Object.freeze({
  faculty_daily_load: 'soft', faculty_weekly_load: 'soft', faculty_consecutive: 'soft', faculty_idle_gap: 'soft',
  student_consecutive: 'soft', student_idle_gap: 'soft', subject_spread: 'soft', room_change: 'soft', day_balance: 'soft',
  division_daily_hours: 'soft', time_of_day: 'soft', lab_per_day: 'hard',
});

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Normalises one rule: stored row over DEFAULT_RULES over the frozen defaults. */
function resolveRule(key, stored, defaultsByKey) {
  const d = defaultsByKey.get(key);
  const row = stored.get(key);
  const params = { ...(PARAM_DEFAULTS[key] || {}), ...((d && d.params) || {}) };
  for (const [k, v] of Object.entries((row && row.params) || {})) {
    if (v !== undefined && v !== null) params[k] = v; // null/undefined = "not set": keep the default
  }
  const enabled = row && typeof row.enabled === 'boolean' ? row.enabled : d ? d.enabled !== false : true;
  const severity = (row && row.severity) || (d && d.severity) || SEVERITY_DEFAULTS[key] || 'soft';
  const weight = num(row && row.weight, num(d && d.weight, 1));
  return { rule_key: key, enabled, severity, weight, params, m: enabled ? weight : 0, hard: enabled && severity === 'hard' };
}

export function buildEngineConfig(rules) {
  const defaultsByKey = new Map(DEFAULT_RULES.map((r) => [r.rule_key, r]));
  const stored = new Map((Array.isArray(rules) ? rules : []).filter((r) => r && r.rule_key).map((r) => [r.rule_key, r]));
  const rule = (key) => resolveRule(key, stored, defaultsByKey);

  const fc = rule('faculty_consecutive');
  const sc = rule('student_consecutive');
  const ig = rule('student_idle_gap');
  const fl = rule('faculty_daily_load');
  const ss = rule('subject_spread');
  const db = rule('day_balance');
  const dh = rule('division_daily_hours');
  const td = rule('time_of_day');
  const rc = rule('room_change');
  const lp = rule('lab_per_day');

  const W = { ...BASE_WEIGHTS, labStart: { ...BASE_WEIGHTS.labStart } };
  W.runFaculty = BASE_WEIGHTS.runFaculty * fc.m;
  W.runDivision = BASE_WEIGHTS.runDivision * sc.m;
  W.idleHour = BASE_WEIGHTS.idleHour * ig.m;
  W.facultyLoad = BASE_WEIGHTS.facultyLoad * fl.m;
  W.facultyOverDefault = BASE_WEIGHTS.facultyOverDefault * fl.m;
  W.sameSubjectNextDay = BASE_WEIGHTS.sameSubjectNextDay * ss.m;
  W.sameSubjectSameDay = BASE_WEIGHTS.sameSubjectSameDay * ss.m;
  W.dayLoad = BASE_WEIGHTS.dayLoad * db.m;
  W.dayOverload = BASE_WEIGHTS.dayOverload * dh.m;
  W.earlyTheory = BASE_WEIGHTS.earlyTheory * td.m;
  W.lateTheory = BASE_WEIGHTS.lateTheory * td.m;
  W.veryLateTheory = BASE_WEIGHTS.veryLateTheory * td.m;
  W.notHomeRoom = BASE_WEIGHTS.notHomeRoom * rc.m;

  const maxDayHours = num(dh.params.max_hours, 6);
  const coreStart = num(td.params.core_start, 645);
  const coreEnd = num(td.params.core_end, 930);
  const lateStart = num(td.params.late_start, 945);
  const runF = num(fc.params.n, 3);
  const runD = num(sc.params.n, 3);
  const defaults = {
    maxRunHours: 3, // harness name; kept for compatibility (faculty and division limits are separate below)
    maxRunFaculty: runF,
    maxRunDivision: runD,
    // a disabled division_daily_hours rule switches the strict-pass daily cap off as well
    maxDayHours: dh.enabled ? maxDayHours : Infinity,
    coreStart,
    coreEnd,
    lateStart,
    facultyDefaultMaxHours: num(fl.params.default_max_hours, 6),
  };

  const hard = {
    // lab blocks per batch per day (hard in every pass); a disabled rule lifts the cap
    labPerDayMax: lp.enabled ? Math.max(1, num(lp.params.max, 1)) : Infinity,
    // sessions of one subject per division and day; 1 reproduces the harness (plus its back-to-back exception)
    subjectPerDayMax: ss.enabled ? Math.max(1, num(ss.params.max_per_day, 1)) : Infinity,
    // severity 'hard' turns the soft rule into a filter (every pass); null = not a filter
    facultyRunHours: fc.hard ? runF : null,
    divisionRunHours: sc.hard ? runD : null,
    divisionDayHours: dh.hard ? maxDayHours : null,
    facultyDayHours: fl.hard ? defaults.facultyDefaultMaxHours : null,
    divisionIdleGapMinutes: ig.hard ? num(ig.params.max_gap_minutes, 60) : null,
    theoryCoreWindow: td.hard ? { start: coreStart, end: coreEnd } : null,
  };

  const resolved = {};
  for (const r of [fc, sc, ig, fl, ss, db, dh, td, rc, lp]) {
    resolved[r.rule_key] = { enabled: r.enabled, severity: r.severity, weight: r.weight, params: r.params };
  }
  return { weights: W, defaults, hard, rules: resolved };
}

/** Config for the default rules (what a term without stored rows gets). */
export const defaultEngineConfig = () => buildEngineConfig(DEFAULT_RULES);
