/**
 * Default planner rule configuration. One planner_rule_config row per entry is
 * created when a term is created. Pure data, no I/O.
 *
 * Entry shape: { rule_key, enabled, severity: 'blocking'|'hard'|'soft', weight, params }
 */

const r = (rule_key, severity, params = {}) => ({ rule_key, enabled: true, severity, weight: 1, params });

export const DEFAULT_RULES = Object.freeze(
  [
    // blocking
    r('faculty_clash', 'blocking'),
    r('room_clash', 'blocking'),
    r('batch_clash', 'blocking'),
    r('working_hours', 'blocking'),
    r('break_overlap', 'blocking'),
    r('grid', 'blocking'),
    r('duration', 'blocking'),
    // hard
    r('room_type', 'hard'),
    r('room_capacity', 'hard'),
    r('all_placed', 'hard'),
    r('lab_per_day', 'hard', { max: 1 }),
    r('lab_weekly', 'hard'),
    // soft
    r('faculty_daily_load', 'soft', { default_max_hours: 6 }),
    r('faculty_consecutive', 'soft', { n: 3 }),
    r('faculty_idle_gap', 'soft', { max_gap_minutes: 180 }),
    r('student_consecutive', 'soft', { n: 3 }),
    r('subject_spread', 'soft', { max_per_day: 1 }),
    r('room_change', 'soft', { min_break_minutes: null, mode: 'any_break' }),
    r('day_balance', 'soft', { max_spread_hours: 3 }),
    // added in Phase 3 (contract 9.2)
    r('division_daily_hours', 'soft', { max_hours: 6 }),
    r('time_of_day', 'soft', { core_start: 645, core_end: 930, late_start: 945 }),
    r('faculty_weekly_load', 'soft'),
    // No free time between a division's lectures of a day (breaks excluded): hard, 0 minutes (contract 10.1). The admin can loosen it.
    r('student_idle_gap', 'hard', { max_gap_minutes: 0 }),
  ].map((rule) => Object.freeze({ ...rule, params: Object.freeze({ ...rule.params }) })),
);

export const RULE_KEYS = Object.freeze(DEFAULT_RULES.map((x) => x.rule_key));
