/**
 * Rule specification (contract 9.2). Pure, no DB, no I/O.
 *
 * RULE_SPEC[rule_key] = { label, description, group:'blocking'|'hard'|'soft', allowed_severities,
 *                         params:{ <name>:{ type:'int'|'enum'|'int_or_null', min?, max?, values?, label } }, zod }
 * The keys are in display order (blocking, hard, soft). `zod` is the schema of a PATCH for that rule; it is a
 * NON-ENUMERABLE property, so JSON.stringify(RULE_SPEC[k]) is the data-driven description the UI renders.
 *
 * validateRulePatch(rule_key, patch, { current }?) never throws:
 *   -> { ok:true, value:{ enabled?, severity?, weight?, params? } }       (only the keys that were sent)
 *   -> { ok:false, errors:{ '<field>': [message, ...] } }                  field = 'enabled' | 'severity' | 'weight'
 *                                                                          | 'params' | 'params.<name>' | 'rule_key' | '_'
 * `current` (optional) is the rule's stored params; a patch's params are checked as default <- current <- patch,
 * so cross-field limits (time_of_day) hold for a partial patch too.
 */
import { z } from 'zod';
import { DEFAULT_RULES } from './ruleDefaults.js';

const WEIGHT = { min: 0, max: 10 };
const TOP_KEYS = new Set(['rule_key', 'enabled', 'severity', 'weight', 'params']);

const defaultsByKey = new Map(DEFAULT_RULES.map((r) => [r.rule_key, r]));

const p = (type, label, extra = {}) => ({ type, label, ...extra });
const intP = (label, min, max) => p('int', label, { min, max });

function entry(rule_key, group, label, description, params = {}, check = null) {
  return { rule_key, group, label, description, params, check };
}

const SPEC_LIST = [
  // ---- blocking
  entry('faculty_clash', 'blocking', 'Faculty double-booked', 'A teacher cannot be in two sessions at the same time.'),
  entry('room_clash', 'blocking', 'Room double-booked', 'A room cannot hold two sessions at once (shared labs may hold several batches up to their capacity).'),
  entry('batch_clash', 'blocking', 'Students double-booked', 'A division or batch cannot have two sessions at the same time.'),
  entry('working_hours', 'blocking', 'Working days and hours', 'Sessions must be on a working day and inside the college day.'),
  entry('break_overlap', 'blocking', 'Break overlap', 'Sessions must not overlap a break.'),
  entry('grid', 'blocking', 'Time grid', "Sessions must start on the term's time grid."),
  entry('duration', 'blocking', 'Session duration', "A session must last as long as its subject's duration."),
  // ---- hard
  entry('room_type', 'hard', 'Room type', "Labs need a lab room; theory sessions use a classroom, and only the division's own home classrooms when it has any."),
  entry('room_capacity', 'hard', 'Room capacity', 'The room must be big enough for the batch or division.'),
  entry('all_placed', 'hard', 'Everything placed', 'Every required session is placed on the timetable.'),
  entry('lab_per_day', 'hard', 'Labs per day', 'Limits how many lab sessions one batch has on a single day.', {
    max: intP('Max lab sessions per batch per day', 1, 5),
  }),
  entry('lab_weekly', 'hard', 'Labs per week', 'A lab subject meets each batch its weekly count; a second lab in a week needs "second lab" ticked on the subject.'),
  entry('student_idle_gap', 'hard', 'Student idle gaps', "No free time between a division's first and last session of a day, except the breaks (hard by default; set the limit above 0 or the severity to soft to allow some).", {
    max_gap_minutes: intP('Longest acceptable idle time per day (minutes)', 0, 720),
  }),
  // ---- soft
  entry('faculty_daily_load', 'soft', 'Teacher daily load', "A teacher's sessions per day stay within their own daily limit, or within the default hours.", {
    default_max_hours: intP('Default max teaching hours per day', 1, 24),
  }),
  entry('faculty_weekly_load', 'soft', 'Teacher weekly load', "A teacher's weekly hours stay within their own weekly limit (only for teachers who have one)."),
  entry('faculty_consecutive', 'soft', 'Teacher back-to-back hours', 'Avoids long unbroken stretches of teaching for a teacher.', {
    n: intP('Max consecutive hours', 1, 12),
  }),
  entry('faculty_idle_gap', 'soft', 'Teacher idle gaps', 'Avoids long free gaps between two sessions of a teacher on one day.', {
    max_gap_minutes: intP('Longest acceptable gap (minutes)', 0, 720),
  }),
  entry('student_consecutive', 'soft', 'Student back-to-back hours', 'Avoids long unbroken stretches of teaching for a division.', {
    n: intP('Max consecutive hours', 1, 12),
  }),
  entry('subject_spread', 'soft', 'Subject spread', 'Spreads a subject over the week instead of repeating it on one day.', {
    max_per_day: intP('Max sessions of one subject per day', 1, 6),
  }),
  entry(
    'room_change',
    'soft',
    'Room changes',
    'Avoids a division moving to another room without a break in between.',
    {
      mode: p('enum', 'Which breaks count', { values: ['any_break', 'lunch_only'] }),
      min_break_minutes: p('int_or_null', 'Minimum break (minutes, empty = any)', { min: 0, max: 240 }),
    },
  ),
  entry('day_balance', 'soft', 'Day balance', "Keeps a division's busiest and lightest days close.", {
    max_spread_hours: intP('Max hours between busiest and lightest day', 0, 12),
  }),
  entry('division_daily_hours', 'soft', 'Division daily hours', 'Limits the teaching hours of a division on one day.', {
    max_hours: intP('Max teaching hours per day', 1, 12),
  }),
  entry(
    'time_of_day',
    'soft',
    'Time of day',
    'Flags theory sessions that start late. The core window only steers the generator (it prefers it) and is never flagged.',
    {
      core_start: intP('Generator prefers starts from (minutes since midnight)', 0, 1439),
      core_end: intP('Generator prefers lectures to end by (minutes since midnight)', 0, 1439),
      late_start: intP('Late starts from (minutes since midnight; flagged)', 0, 1439),
    },
    (merged) => {
      const errs = {};
      if (merged.core_start >= merged.core_end) errs.core_start = ['must be before the core window end'];
      if (merged.core_end > merged.late_start) errs.late_start = ['must not be before the core window end'];
      return errs;
    },
  ),
];

function paramSchema(def) {
  if (def.type === 'enum') return z.enum(def.values, { error: `must be one of: ${def.values.join(', ')}` });
  const base = z
    .number({ error: 'must be a whole number' })
    .int('must be a whole number')
    .min(def.min, `must be ${def.min} or more`)
    .max(def.max, `must be ${def.max} or less`);
  return def.type === 'int_or_null' ? base.nullable() : base;
}

function buildSchema(group, params) {
  const shape = {};
  for (const [name, def] of Object.entries(params)) shape[name] = paramSchema(def).optional();
  const allowed = group === 'blocking' ? ['blocking'] : ['hard', 'soft'];
  return z.object({
    enabled: z.boolean({ error: 'must be true or false' }).optional(),
    severity: z.enum(allowed, { error: `must be ${allowed.map((x) => `"${x}"`).join(' or ')}` }).optional(),
    weight: z
      .number({ error: 'must be a whole number' })
      .int('must be a whole number')
      .min(WEIGHT.min, `must be ${WEIGHT.min} or more`)
      .max(WEIGHT.max, `must be ${WEIGHT.max} or less`)
      .optional(),
    params: z.strictObject(shape, { error: 'must be an object of this rule\'s settings' }).optional(),
  });
}

const spec = {};
for (const e of SPEC_LIST) {
  const blocking = e.group === 'blocking';
  const out = {
    label: e.label,
    description: e.description,
    group: e.group,
    allowed_severities: blocking ? ['blocking'] : ['hard', 'soft'],
    params: e.params,
  };
  Object.defineProperty(out, 'zod', { value: buildSchema(e.group, e.params), enumerable: false });
  Object.defineProperty(out, 'check', { value: e.check, enumerable: false });
  for (const d of Object.values(e.params)) Object.freeze(d);
  Object.freeze(out.params);
  Object.freeze(out.allowed_severities);
  spec[e.rule_key] = Object.freeze(out);
}

export const RULE_SPEC = Object.freeze(spec);

/** Rule keys in display order (blocking, hard, soft). Same 23 keys as RULE_KEYS in ruleDefaults.js. */
export const RULE_ORDER = Object.freeze(Object.keys(RULE_SPEC));

function addErr(errors, field, msg) {
  (errors[field] ||= []).push(msg);
}

export function validateRulePatch(rule_key, patch, { current } = {}) {
  const errors = {};
  const sp = Object.prototype.hasOwnProperty.call(RULE_SPEC, rule_key) ? RULE_SPEC[rule_key] : null;
  if (!sp) return { ok: false, errors: { rule_key: [`"${String(rule_key)}" is not a known rule`] } };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, errors: { _: ['must be an object'] } };

  for (const k of Object.keys(patch)) {
    if (!TOP_KEYS.has(k)) addErr(errors, k, 'is not a field of a rule');
  }
  if ('rule_key' in patch && patch.rule_key !== rule_key) addErr(errors, 'rule_key', 'does not match the rule being edited');

  // zod parse of the editable fields only
  const body = {};
  for (const k of ['enabled', 'severity', 'weight', 'params']) if (k in patch && patch[k] !== undefined) body[k] = patch[k];
  const result = sp.zod.safeParse(body);
  if (!result.success) {
    for (const issue of result.error.issues) {
      if (issue.code === 'unrecognized_keys') {
        const base = issue.path.join('.');
        for (const key of issue.keys) addErr(errors, base ? `${base}.${key}` : key, 'is not a setting of this rule');
      } else {
        addErr(errors, issue.path.length ? issue.path.join('.') : '_', issue.message);
      }
    }
  }

  const def = defaultsByKey.get(rule_key);
  if (sp.group === 'blocking') {
    // read-only: echoing the fixed values is fine, changing them is not
    if ('enabled' in body && body.enabled !== true) addErr(errors, 'enabled', 'cannot be changed: this rule is always on');
    if ('severity' in body && body.severity !== 'blocking' && !errors.severity) addErr(errors, 'severity', 'cannot be changed: this rule always blocks');
    if ('weight' in body && body.weight !== def.weight && !errors.weight) addErr(errors, 'weight', 'cannot be changed');
    if ('params' in body && body.params && Object.keys(body.params).length) addErr(errors, 'params', 'this rule has no settings');
  }

  // cross-field limits on the merged params (default <- current <- patch)
  if (result.success && result.data.params && sp.check) {
    const merged = { ...def.params, ...(current && typeof current === 'object' ? current : {}), ...result.data.params };
    for (const [field, msgs] of Object.entries(sp.check(merged))) for (const m of msgs) addErr(errors, `params.${field}`, m);
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: result.data };
}
