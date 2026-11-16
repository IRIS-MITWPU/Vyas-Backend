import test from 'node:test';
import assert from 'node:assert/strict';
import { RULE_SPEC, RULE_ORDER, validateRulePatch } from '../../../services/planner/domain/ruleSpec.js';
import { DEFAULT_RULES, RULE_KEYS } from '../../../services/planner/domain/ruleDefaults.js';
import * as domain from '../../../services/planner/domain/index.js';

const BLOCKING = ['faculty_clash', 'room_clash', 'batch_clash', 'working_hours', 'break_overlap', 'grid', 'duration'];
const ok = (key, patch, opts) => {
  const r = validateRulePatch(key, patch, opts);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.value;
};
const bad = (key, patch, opts) => {
  const r = validateRulePatch(key, patch, opts);
  assert.equal(r.ok, false, `expected a failure for ${JSON.stringify(patch)}`);
  return r.errors;
};

test('RULE_SPEC covers exactly the 23 default keys, blocking first, and is exported from the domain index', () => {
  assert.equal(RULE_ORDER.length, 23);
  assert.deepEqual([...RULE_ORDER].sort(), [...RULE_KEYS].sort());
  assert.deepEqual([...RULE_ORDER.slice(0, 7)].sort(), [...BLOCKING].sort());
  assert.equal(domain.RULE_SPEC, RULE_SPEC);
  assert.equal(domain.validateRulePatch, validateRulePatch);
  const groups = RULE_ORDER.map((k) => RULE_SPEC[k].group);
  assert.deepEqual([...groups].sort((a, b) => ['blocking', 'hard', 'soft'].indexOf(a) - ['blocking', 'hard', 'soft'].indexOf(b)), groups, 'ordered blocking, hard, soft');
});

test('every entry: label, description, group matching the default severity, allowed severities, JSON-safe', () => {
  for (const d of DEFAULT_RULES) {
    const s = RULE_SPEC[d.rule_key];
    assert.ok(s.label && s.description, d.rule_key);
    assert.equal(s.group, d.severity, d.rule_key);
    assert.deepEqual(s.allowed_severities, d.severity === 'blocking' ? ['blocking'] : ['hard', 'soft'], d.rule_key);
    assert.deepEqual(Object.keys(s.params).sort(), Object.keys(d.params).sort(), `${d.rule_key}: spec params == default params`);
    for (const p of Object.values(s.params)) assert.ok(['int', 'enum', 'int_or_null'].includes(p.type) && p.label);
    assert.equal(typeof s.zod.safeParse, 'function');
    assert.equal(Object.keys(s).includes('zod'), false, 'zod is not enumerable, so the spec serialises');
    assert.ok(JSON.stringify(s).length > 20);
    // every default value is valid for its own spec
    assert.equal(validateRulePatch(d.rule_key, { params: d.params }).ok, true, d.rule_key);
  }
  assert.deepEqual(RULE_SPEC.room_change.params.mode.values, ['any_break', 'lunch_only']);
  assert.equal(RULE_SPEC.room_change.params.min_break_minutes.type, 'int_or_null');
});

test('validate: unknown rule, non-object patch, unknown field', () => {
  assert.ok(bad('nope', {}).rule_key);
  assert.ok(bad('grid', null)._);
  assert.ok(bad('grid', [])._);
  assert.ok(bad('day_balance', { colour: 'red' }).colour);
  assert.ok(bad('day_balance', { rule_key: 'grid' }).rule_key);
  assert.deepEqual(ok('day_balance', { rule_key: 'day_balance' }), {});
});

test('validate: blocking rules are read-only (echoing the fixed values is fine)', () => {
  for (const k of BLOCKING) {
    assert.ok(bad(k, { enabled: false }).enabled, k);
    assert.ok(bad(k, { severity: 'soft' }).severity, k);
    assert.ok(bad(k, { severity: 'hard' }).severity, k);
    assert.ok(bad(k, { weight: 5 }).weight, k);
    assert.ok(bad(k, { params: { n: 1 } }).params, k);
    assert.deepEqual(ok(k, { enabled: true, severity: 'blocking', weight: 1, params: {} }), { enabled: true, severity: 'blocking', weight: 1, params: {} });
  }
});

test('validate: severity hard <-> soft, never blocking, for the other rules; enabled and weight', () => {
  for (const d of DEFAULT_RULES.filter((r) => r.severity !== 'blocking')) {
    assert.deepEqual(ok(d.rule_key, { severity: 'hard' }), { severity: 'hard' });
    assert.deepEqual(ok(d.rule_key, { severity: 'soft', enabled: false, weight: 10 }), { severity: 'soft', enabled: false, weight: 10 });
    assert.ok(bad(d.rule_key, { severity: 'blocking' }).severity);
    assert.ok(bad(d.rule_key, { severity: 'meh' }).severity);
  }
  assert.ok(bad('day_balance', { weight: -1 }).weight);
  assert.ok(bad('day_balance', { weight: 11 }).weight);
  assert.ok(bad('day_balance', { weight: 2.5 }).weight);
  assert.ok(bad('day_balance', { weight: '3' }).weight);
  assert.deepEqual(ok('day_balance', { weight: 0 }), { weight: 0 });
  assert.ok(bad('day_balance', { enabled: 'yes' }).enabled);
});

test('validate: typed params (int ranges, enum, int_or_null)', () => {
  assert.deepEqual(ok('faculty_consecutive', { params: { n: 4 } }), { params: { n: 4 } });
  assert.ok(bad('faculty_consecutive', { params: { n: 0 } })['params.n']);
  assert.ok(bad('faculty_consecutive', { params: { n: 13 } })['params.n']);
  assert.ok(bad('faculty_consecutive', { params: { n: 2.5 } })['params.n']);
  assert.ok(bad('faculty_consecutive', { params: { n: '3' } })['params.n']);
  assert.ok(bad('faculty_consecutive', { params: { n: null } })['params.n']);
  assert.ok(bad('faculty_consecutive', { params: { zzz: 1 } })['params.zzz']);
  assert.ok(bad('faculty_consecutive', { params: 5 }).params);
  assert.ok(bad('lab_per_day', { params: { max: 0 } })['params.max']);
  assert.ok(bad('subject_spread', { params: { max_per_day: 7 } })['params.max_per_day']);
  assert.ok(bad('faculty_idle_gap', { params: { max_gap_minutes: -5 } })['params.max_gap_minutes']);
  assert.deepEqual(ok('student_idle_gap', { params: { max_gap_minutes: 0 } }), { params: { max_gap_minutes: 0 } });
  assert.deepEqual(ok('room_change', { params: { mode: 'lunch_only', min_break_minutes: 20 } }), { params: { mode: 'lunch_only', min_break_minutes: 20 } });
  assert.deepEqual(ok('room_change', { params: { min_break_minutes: null } }), { params: { min_break_minutes: null } });
  assert.ok(bad('room_change', { params: { mode: 'always' } })['params.mode']);
  assert.ok(bad('room_change', { params: { min_break_minutes: 'x' } })['params.min_break_minutes']);
  assert.ok(bad('room_change', { params: { min_break_minutes: 241 } })['params.min_break_minutes']);
  assert.ok(bad('faculty_weekly_load', { params: { max: 1 } })['params.max'], 'a rule without settings rejects params');
  assert.deepEqual(ok('faculty_weekly_load', { params: {} }), { params: {} });
});

test('validate: time_of_day cross-field limits use default <- current <- patch', () => {
  assert.deepEqual(ok('time_of_day', { params: { core_start: 600, core_end: 900, late_start: 900 } }).params.late_start, 900);
  assert.ok(bad('time_of_day', { params: { core_start: 900, core_end: 800 } })['params.core_start']);
  assert.ok(bad('time_of_day', { params: { core_end: 1000 } })['params.late_start'], 'late_start default 945 < core_end 1000');
  assert.ok(bad('time_of_day', { params: { core_start: 940 } })['params.core_start'], 'default core_end 930');
  assert.deepEqual(ok('time_of_day', { params: { core_start: 700 } }), { params: { core_start: 700 } });
  // the stored params take part
  assert.ok(bad('time_of_day', { params: { core_start: 700 } }, { current: { core_end: 650 } })['params.core_start']);
  assert.ok(bad('time_of_day', { params: { core_start: 0 } }, { current: { core_end: 0 } })['params.core_start']);
});

test('validate: only the sent keys come back; several errors are all reported', () => {
  assert.deepEqual(ok('faculty_daily_load', { enabled: false }), { enabled: false });
  const errors = bad('faculty_daily_load', { enabled: 1, severity: 'x', weight: 99, params: { default_max_hours: 0, q: 1 } });
  assert.deepEqual(Object.keys(errors).sort(), ['enabled', 'params.default_max_hours', 'params.q', 'severity', 'weight']);
});
