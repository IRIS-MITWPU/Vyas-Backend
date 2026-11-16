// Helpers for the rule engine unit tests (not a test file). Small snapshot-shaped worlds come from the Phase 2 test kit
// (mini / placeIn); `run` evaluates ONE rule with its default row (optionally overridden).
import { mini, sessionOf, roomId, placeIn } from '../real/lib/testkit.mjs';
import { evaluateRule } from '../../../services/planner/engine/evaluate.js';
import { DEFAULT_RULES } from '../../../services/planner/domain/ruleDefaults.js';

export { mini, sessionOf, roomId, placeIn, evaluateRule };

/** The default rule row of `key`, with fields (and params, merged) overridden. */
export function row(key, over = {}) {
  const d = DEFAULT_RULES.find((r) => r.rule_key === key);
  return { ...d, ...over, params: { ...d.params, ...(over.params || {}) } };
}

/** Issues of one rule over a world. over = {severity?, enabled?, weight?, params?}. */
export const run = (key, world, over = {}) => evaluateRule(key, world, row(key, over));

/** place(world, division, subjectCode, batch|'ALL', seq, day, startMin, roomName) */
export function put(world, div, code, batch, seq, day, start, room) {
  return placeIn(world, sessionOf(world, div, code, batch, seq), day, start, room ? roomId(world, room) : null);
}

/** Standard start times of the default term (60 min cells, breaks 10:30, 12:45-13:30, 15:30). */
export const T = { s0830: 510, s0930: 570, s1045: 645, s1145: 705, s1330: 810, s1430: 870, s1545: 945, s1645: 1005 };

/** A one-division world with `weekly` theory sessions of DS (faculty A) and room C1/C2 (classrooms). */
export function theoryWorld({ weekly = 4, students = 60, cap = 60, faculty = ['A'], extra = {} } = {}) {
  return mini({
    rooms: [{ name: 'C1', cap }, { name: 'C2', cap }],
    faculty,
    subjects: [{ code: 'DS', kind: 'theory', weekly }],
    divisions: [{ name: 'CSE-A', students, sem: 3, home: 'C1' }],
    offerings: [{ div: 'CSE-A', code: 'DS', faculty: faculty[0] }],
    ...extra,
  });
}

/** Messages of an issue list (for readable assertion failures). */
export const msgs = (issues) => issues.map((i) => i.message);
