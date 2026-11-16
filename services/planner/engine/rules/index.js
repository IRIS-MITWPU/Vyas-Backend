// Registry of the diagnostic rules: RULES[rule_key] = { key, check(ctx) -> Issue[] } for every one of the 23 keys.
import { PLACEMENT_RULES } from './placement.js';
import { CLASH_RULES } from './clashes.js';
import { ROOM_RULES } from './rooms.js';
import { LAB_RULES } from './labs.js';
import { FACULTY_RULES } from './faculty.js';
import { DIVISION_RULES } from './division.js';
import { LAYOUT_RULES } from './layout.js';

export { buildContext, forRule } from './context.js';

const ALL = [...CLASH_RULES, ...PLACEMENT_RULES, ...ROOM_RULES, ...LAB_RULES, ...FACULTY_RULES, ...DIVISION_RULES, ...LAYOUT_RULES];

export const RULES = Object.freeze(Object.fromEntries(ALL.map((r) => [r.key, r])));
