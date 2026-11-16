// Rule engine entry points (contract 9.3). Pure: a snapshot (GET /versions/:id/snapshot body) and the merged rule rows
// (services/planner/rules.js loadRules) in, issues out. No DB, no I/O, no clock.
//
//   evaluateAll(snapshot, rules)  -> { publishable, counts:{blocking,hard,soft}, by_division, issues }
//   evaluateRule(key, snapshot, ruleRow) -> Issue[]
//
// `rev` is not set here (the route adds it). Rows with enabled=false are skipped. An issue carries the severity of its
// rule row ('hard' | 'soft'); blocking rules always report 'blocking', whatever the row says.
import { DEFAULT_RULES } from '../domain/ruleDefaults.js';
import { RULE_SPEC, RULE_ORDER } from '../domain/ruleSpec.js';
import { RULES, buildContext, forRule } from './rules/index.js';

const defaultByKey = new Map(DEFAULT_RULES.map((r) => [r.rule_key, r]));
const SEV_RANK = { blocking: 0, hard: 1, soft: 2 };

/** The effective row of a rule: given row over the default; blocking rows forced to blocking/enabled. */
function effectiveRow(key, row) {
  const def = defaultByKey.get(key);
  const spec = RULE_SPEC[key];
  const r = row || def;
  if (spec.group === 'blocking') return { rule_key: key, enabled: true, severity: 'blocking', weight: def.weight, params: { ...def.params } };
  return {
    rule_key: key,
    enabled: r.enabled !== false,
    severity: spec.allowed_severities.includes(r.severity) ? r.severity : def.severity,
    weight: Number.isInteger(r.weight) ? r.weight : def.weight,
    params: { ...def.params, ...(r.params && typeof r.params === 'object' ? r.params : {}) },
  };
}

function runRule(world, key, row) {
  const rule = effectiveRow(key, row);
  if (!rule.enabled) return [];
  return RULES[key].check(forRule(world, rule));
}

/** Issues of ONE rule row (a disabled row gives []). Unknown key -> []. */
export function evaluateRule(key, snapshot, ruleRow) {
  if (!RULES[key]) return [];
  return runRule(buildContext(snapshot), key, ruleRow);
}

/**
 * @param snapshot  GET /snapshot body
 * @param rules     merged rule rows [{rule_key, enabled, severity, weight, params}] (a missing key = its default row)
 * @returns {{publishable:boolean, counts:{blocking:number,hard:number,soft:number}, by_division:Object, issues:Issue[]}}
 *   issues sorted blocking, hard, soft, then division (snapshot order, none last), weekday (none last), id.
 *   by_division[division_id] = {hard, soft} for every division of the snapshot; an issue counts for each division
 *   of its sessions (blocking issues are in counts.blocking only).
 */
export function evaluateAll(snapshot, rules = DEFAULT_RULES) {
  const world = buildContext(snapshot);
  const rows = new Map((rules || []).map((r) => [r.rule_key, r]));
  const issues = [];
  for (const key of RULE_ORDER) issues.push(...runRule(world, key, rows.get(key)));

  const order = (id) => (id && world.divOrder.has(id) ? world.divOrder.get(id) : Number.MAX_SAFE_INTEGER);
  issues.sort(
    (a, b) =>
      SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
      order(a.division_id) - order(b.division_id) ||
      (a.weekday ?? 99) - (b.weekday ?? 99) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const counts = { blocking: 0, hard: 0, soft: 0 };
  const by_division = {};
  for (const d of world.divisions) by_division[d.id] = { hard: 0, soft: 0 };
  for (const issue of issues) {
    counts[issue.severity] += 1;
    if (issue.severity === 'blocking') continue;
    const divs = new Set();
    if (issue.division_id) divs.add(issue.division_id);
    for (const sid of issue.session_ids) {
      const did = world.byId.get(sid)?.division?.id;
      if (did) divs.add(did);
    }
    for (const did of divs) if (by_division[did]) by_division[did][issue.severity] += 1;
  }
  return { publishable: counts.blocking === 0 && counts.hard === 0, counts, by_division, issues };
}
