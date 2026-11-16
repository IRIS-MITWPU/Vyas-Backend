import { z } from "zod";
import { parse } from "./validate.js";
import { invalid } from "./errors.js";
import { requireTerm } from "./terms.js";
import { DEFAULT_RULES, RULE_SPEC, RULE_ORDER, validateRulePatch } from "./domain/index.js";

// Rule configuration of a term (contract 9.7). `db` is a pg Pool or a pg client (like the other services).
// Readers get the stored rows merged over DEFAULT_RULES; writers upsert on (term_id, rule_key).
// Blocking rules are always read as {enabled:true, severity:'blocking', weight:1, params:{}} and cannot be edited.

const defaultsByKey = new Map(DEFAULT_RULES.map((r) => [r.rule_key, r]));

const patchBody = z.object({
  rules: z
    .array(z.object({ rule_key: z.string({ error: "is required" }) }).passthrough(), { error: "must be a list of rules" })
    .min(1, "send at least one rule")
    .max(30, "send at most 30 rules"),
});

/** Runs fn(client) in a transaction. A pg client (already checked out) is used as is: the caller owns its transaction. */
async function inTx(db, fn) {
  if (typeof db.release === "function") return fn(db); // a client
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* keep the original error */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** One merged rule row: stored values over the default, params merged key by key; blocking rows are forced. */
function mergeRow(def, stored) {
  const spec = RULE_SPEC[def.rule_key];
  if (spec.group === "blocking") {
    return { rule_key: def.rule_key, enabled: true, severity: "blocking", weight: def.weight, params: { ...def.params }, spec };
  }
  const sev = stored && spec.allowed_severities.includes(stored.severity) ? stored.severity : def.severity;
  return {
    rule_key: def.rule_key,
    enabled: stored ? stored.enabled !== false : def.enabled,
    severity: sev,
    weight: stored && Number.isInteger(stored.weight) ? stored.weight : def.weight,
    params: { ...def.params, ...(stored && stored.params && typeof stored.params === "object" ? stored.params : {}) },
    spec,
  };
}

async function loadStored(db, termId) {
  const { rows } = await db.query(
    "SELECT rule_key, enabled, severity, weight, params FROM planner_rule_config WHERE term_id = $1",
    [termId]
  );
  return new Map(rows.map((r) => [r.rule_key, r]));
}

const toRows = (stored) => RULE_ORDER.map((k) => mergeRow(defaultsByKey.get(k), stored.get(k)));

/** The 23 merged rows in RULE_SPEC order: [{rule_key, enabled, severity, weight, params, spec}]. 404 for an unknown term. */
export async function loadRules(db, termId) {
  await requireTerm(db, termId);
  return toRows(await loadStored(db, termId));
}

const UPSERT = `
  INSERT INTO planner_rule_config (term_id, rule_key, enabled, severity, weight, params)
  SELECT $1, x.rule_key, x.enabled, x.severity, x.weight, x.params
    FROM jsonb_to_recordset($2::jsonb) AS x(rule_key text, enabled boolean, severity text, weight int, params jsonb)
  ON CONFLICT (term_id, rule_key) DO UPDATE
    SET enabled = EXCLUDED.enabled, severity = EXCLUDED.severity, weight = EXCLUDED.weight, params = EXCLUDED.params`;

const plain = (r) => ({ rule_key: r.rule_key, enabled: r.enabled, severity: r.severity, weight: r.weight, params: r.params });

/**
 * body {rules:[{rule_key, enabled?, severity?, weight?, params?}]} (1..30). All or nothing: every entry is validated
 * first (400 VALIDATION_ERROR, fieldErrors keyed `rules.<i>.<field>`, params as `rules.<i>.params.<name>`), then the
 * changed rows are upserted in ONE statement inside a transaction. `params` are merged over the stored ones.
 * Returns the 23 merged rows.
 */
export async function patchRules(db, termId, body) {
  const b = parse(patchBody, body);
  return inTx(db, async (tx) => {
    await requireTerm(tx, termId, { lock: true });
    const current = new Map(toRows(await loadStored(tx, termId)).map((r) => [r.rule_key, r]));

    const fieldErrors = {};
    const seen = new Map();
    const next = new Map();
    b.rules.forEach((entry, i) => {
      const key = entry.rule_key;
      const add = (field, msg) => (fieldErrors[`rules.${i}.${field}`] ||= []).push(msg);
      if (seen.has(key)) return add("rule_key", `appears twice in this request (also at position ${seen.get(key)})`);
      seen.set(key, i);
      const cur = current.get(key);
      if (!cur) return add("rule_key", `"${key}" is not a known rule`);
      const v = validateRulePatch(key, entry, { current: cur.params });
      if (!v.ok) {
        for (const [field, msgs] of Object.entries(v.errors)) for (const m of msgs) add(field === "_" ? "rule_key" : field, m);
        return;
      }
      // blocking rules: validated (echoes allowed) but never written
      if (RULE_SPEC[key].group === "blocking") return;
      next.set(key, {
        ...cur,
        ...(v.value.enabled !== undefined ? { enabled: v.value.enabled } : {}),
        ...(v.value.severity !== undefined ? { severity: v.value.severity } : {}),
        ...(v.value.weight !== undefined ? { weight: v.value.weight } : {}),
        params: v.value.params ? { ...cur.params, ...v.value.params } : cur.params,
      });
    });
    if (Object.keys(fieldErrors).length) throw invalid("Some rule settings are invalid", fieldErrors);

    if (next.size) {
      await tx.query(UPSERT, [termId, JSON.stringify([...next.values()].map(plain))]);
      for (const [k, v] of next) current.set(k, v);
    }
    return RULE_ORDER.map((k) => current.get(k));
  });
}

/** Restores every rule to DEFAULT_RULES (stale rows deleted, all 23 defaults written) in one transaction. */
export async function resetRules(db, termId) {
  return inTx(db, async (tx) => {
    await requireTerm(tx, termId, { lock: true });
    await tx.query("DELETE FROM planner_rule_config WHERE term_id = $1", [termId]);
    await tx.query(UPSERT, [termId, JSON.stringify(DEFAULT_RULES)]);
    return toRows(await loadStored(tx, termId));
  });
}
