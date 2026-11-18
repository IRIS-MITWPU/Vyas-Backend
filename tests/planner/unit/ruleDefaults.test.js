import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES } from '../../../services/planner/domain/ruleDefaults.js';

const byKey = Object.fromEntries(DEFAULT_RULES.map((r) => [r.rule_key, r]));

test('rule keys are unique and complete (the contract lists 23 keys)', () => {
  assert.equal(new Set(DEFAULT_RULES.map((r) => r.rule_key)).size, DEFAULT_RULES.length);
  assert.equal(DEFAULT_RULES.length, 23);
});

test('severities', () => {
  for (const k of ['faculty_clash', 'room_clash', 'batch_clash', 'working_hours', 'break_overlap', 'grid', 'duration']) {
    assert.equal(byKey[k].severity, 'blocking', k);
  }
  for (const k of ['room_type', 'room_capacity', 'all_placed', 'lab_per_day', 'lab_weekly', 'student_idle_gap']) {
    assert.equal(byKey[k].severity, 'hard', k);
  }
  for (const k of ['faculty_daily_load', 'faculty_consecutive', 'faculty_idle_gap', 'student_consecutive', 'subject_spread', 'room_change', 'day_balance', 'division_daily_hours', 'time_of_day', 'faculty_weekly_load']) {
    assert.equal(byKey[k].severity, 'soft', k);
  }
});

test('params', () => {
  assert.deepEqual(byKey.lab_per_day.params, { max: 1 });
  assert.deepEqual(byKey.faculty_consecutive.params, { n: 3 });
  assert.deepEqual(byKey.student_consecutive.params, { n: 3 });
  assert.deepEqual(byKey.room_change.params, { min_break_minutes: null, mode: 'any_break' });
  assert.deepEqual(byKey.faculty_daily_load.params, { default_max_hours: 6 });
  assert.deepEqual(byKey.faculty_idle_gap.params, { max_gap_minutes: 180 });
  assert.deepEqual(byKey.subject_spread.params, { max_per_day: 1 });
  assert.deepEqual(byKey.day_balance.params, { max_spread_hours: 3 });
  assert.deepEqual(byKey.division_daily_hours.params, { max_hours: 6 });
  assert.deepEqual(byKey.time_of_day.params, { core_start: 645, core_end: 930, late_start: 945 });
  assert.deepEqual(byKey.faculty_weekly_load.params, {});
  assert.deepEqual(byKey.student_idle_gap.params, { max_gap_minutes: 0 });
  assert.equal(byKey.student_idle_gap.severity, 'hard', "no idle time between a division's lectures is a hard rule by default");
  assert.deepEqual(byKey.grid.params, {});
});

test('every rule is enabled with weight and JSON-serialisable', () => {
  for (const r of DEFAULT_RULES) {
    assert.equal(r.enabled, true);
    assert.equal(typeof r.weight, 'number');
    assert.equal(typeof r.params, 'object');
  }
  assert.deepEqual(JSON.parse(JSON.stringify(DEFAULT_RULES)), DEFAULT_RULES);
});
