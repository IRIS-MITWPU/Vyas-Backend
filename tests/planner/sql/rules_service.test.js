// Service-level test of services/planner/rules.js against the LOCAL dev Postgres (no server needed).
// Creates its own throwaway term (branch zz_planner_test_<uid>) through createTerm and deletes it afterwards.
//
//   node --test tests/planner/sql/rules_service.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pool from "../../../database/db.js";
import { createTerm } from "../../../services/planner/terms.js";
import { loadRules, patchRules, resetRules } from "../../../services/planner/rules.js";
import { DEFAULT_RULES, RULE_ORDER, RULE_KEYS } from "../../../services/planner/domain/index.js";

const uid = randomBytes(4).toString("hex");
const BRANCH = `zz_planner_test_${uid}`;
let termId;

before(async () => {
  assert.equal(process.env.DB_HOST, "localhost", "planner SQL tests must only run against a local DB");
  const { term } = await createTerm({ academic_year: BRANCH, half: "odd", branch: BRANCH }, null);
  termId = term.id;
});

after(async () => {
  if (termId) await pool.query("DELETE FROM planner_terms WHERE id = $1 AND branch = $2", [termId, BRANCH]);
  await pool.end();
});

const stored = async () => (await pool.query("SELECT rule_key, enabled, severity, weight, params FROM planner_rule_config WHERE term_id = $1", [termId])).rows;
const row = (rules, key) => rules.find((r) => r.rule_key === key);
const rejects = async (fn, check) => {
  await assert.rejects(fn, (err) => {
    assert.equal(err.code, "VALIDATION_ERROR");
    assert.equal(err.status, 400);
    check(err.details.fieldErrors);
    return true;
  });
};

test("createTerm seeds all 23 default rules; loadRules returns them merged, in spec order", async () => {
  assert.equal((await stored()).length, 23);
  const rules = await loadRules(pool, termId);
  assert.equal(rules.length, 23);
  assert.deepEqual(rules.map((r) => r.rule_key), RULE_ORDER);
  assert.deepEqual([...rules.map((r) => r.rule_key)].sort(), [...RULE_KEYS].sort());
  for (const r of rules) {
    const d = DEFAULT_RULES.find((x) => x.rule_key === r.rule_key);
    assert.equal(r.enabled, d.enabled);
    assert.equal(r.severity, d.severity);
    assert.equal(r.weight, d.weight);
    assert.deepEqual(r.params, d.params);
    assert.equal(typeof r.spec.label, "string");
    assert.deepEqual(r.spec.allowed_severities, d.severity === "blocking" ? ["blocking"] : ["hard", "soft"]);
  }
});

test("loadRules: unknown term is 404", async () => {
  await assert.rejects(() => loadRules(pool, "00000000-0000-4000-8000-000000000000"), (e) => e.code === "NOT_FOUND" && e.status === 404);
});

test("legacy term (19 stored rows): the 4 new rules come from the defaults, then get stored on first PATCH", async () => {
  await pool.query(
    "DELETE FROM planner_rule_config WHERE term_id = $1 AND rule_key = ANY($2)",
    [termId, ["division_daily_hours", "time_of_day", "faculty_weekly_load", "student_idle_gap"]]
  );
  assert.equal((await stored()).length, 19);
  // an older stored row without the params added in Phase 3 still reads with them
  await pool.query(`UPDATE planner_rule_config SET params = '{}'::jsonb WHERE term_id = $1 AND rule_key = 'faculty_idle_gap'`, [termId]);
  let rules = await loadRules(pool, termId);
  assert.equal(rules.length, 23);
  assert.deepEqual(row(rules, "time_of_day").params, { core_start: 645, core_end: 930, late_start: 945 });
  assert.deepEqual(row(rules, "faculty_idle_gap").params, { max_gap_minutes: 180 });
  assert.equal((await stored()).length, 19, "reading never writes");

  rules = await patchRules(pool, termId, { rules: [{ rule_key: "student_idle_gap", params: { max_gap_minutes: 90 } }] });
  assert.equal(rules.length, 23);
  assert.equal(row(rules, "student_idle_gap").params.max_gap_minutes, 90);
  assert.equal((await stored()).length, 20, "the patched row is now stored");
});

test("patch: stored values win, params merge, blocking rows are untouched", async () => {
  const rules = await patchRules(pool, termId, {
    rules: [
      { rule_key: "faculty_consecutive", enabled: false, severity: "hard", weight: 7, params: { n: 4 } },
      { rule_key: "room_change", params: { mode: "lunch_only" } },
      { rule_key: "faculty_clash", enabled: true, severity: "blocking" }, // echo of the fixed values is accepted, never written
    ],
  });
  const fc = row(rules, "faculty_consecutive");
  assert.deepEqual({ e: fc.enabled, s: fc.severity, w: fc.weight, p: fc.params }, { e: false, s: "hard", w: 7, p: { n: 4 } });
  assert.deepEqual(row(rules, "room_change").params, { min_break_minutes: null, mode: "lunch_only" }, "partial params merge over the stored ones");
  const again = await loadRules(pool, termId);
  assert.deepEqual(again.map((r) => ({ ...r, spec: undefined })), rules.map((r) => ({ ...r, spec: undefined })));
  assert.equal((await stored()).filter((r) => r.rule_key === "faculty_clash").length, 1);
});

test("patch: all or nothing, errors keyed rules.<i>.<field>", async () => {
  const before = JSON.stringify(await stored());
  await rejects(
    () =>
      patchRules(pool, termId, {
        rules: [
          { rule_key: "student_consecutive", weight: 2 }, // valid, must NOT be written
          { rule_key: "faculty_clash", enabled: false },
          { rule_key: "nope", enabled: true },
          { rule_key: "day_balance", severity: "blocking", weight: 11, params: { max_spread_hours: 2.5, zzz: 1 } },
          { rule_key: "time_of_day", params: { core_start: 1000 } },
          { rule_key: "student_consecutive" },
        ],
      }),
    (fe) => {
      assert.ok(fe["rules.1.enabled"], JSON.stringify(fe));
      assert.ok(fe["rules.2.rule_key"]);
      assert.ok(fe["rules.3.severity"]);
      assert.ok(fe["rules.3.weight"]);
      assert.ok(fe["rules.3.params.max_spread_hours"]);
      assert.ok(fe["rules.3.params.zzz"]);
      assert.ok(fe["rules.4.params.core_start"]);
      assert.ok(fe["rules.5.rule_key"], "duplicate key in one body");
      assert.equal(fe["rules.0.weight"], undefined);
    }
  );
  assert.equal(JSON.stringify(await stored()), before, "nothing written");
  await rejects(() => patchRules(pool, termId, { rules: [] }), (fe) => assert.ok(fe.rules));
  await rejects(() => patchRules(pool, termId, {}), (fe) => assert.ok(fe.rules));
  await rejects(() => patchRules(pool, termId, { rules: Array.from({ length: 31 }, () => ({ rule_key: "grid" })) }), (fe) => assert.ok(fe.rules));
});

test("patch: blocking severity stored by hand is still read as blocking", async () => {
  await pool.query(`UPDATE planner_rule_config SET severity = 'soft', enabled = false WHERE term_id = $1 AND rule_key = 'batch_clash'`, [termId]);
  const r = row(await loadRules(pool, termId), "batch_clash");
  assert.equal(r.severity, "blocking");
  assert.equal(r.enabled, true);
});

test("patch: works on a checked-out client inside the caller's transaction", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rules = await patchRules(client, termId, { rules: [{ rule_key: "day_balance", weight: 5 }] });
    assert.equal(row(rules, "day_balance").weight, 5);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  assert.equal(row(await loadRules(pool, termId), "day_balance").weight, 1);
});

test("reset restores the 23 defaults (and removes stale rows)", async () => {
  await pool.query(`INSERT INTO planner_rule_config (term_id, rule_key, severity) VALUES ($1, 'zz_stale', 'soft')`, [termId]);
  const rules = await resetRules(pool, termId);
  assert.equal(rules.length, 23);
  assert.equal((await stored()).length, 23);
  for (const r of rules) {
    const d = DEFAULT_RULES.find((x) => x.rule_key === r.rule_key);
    assert.deepEqual({ e: r.enabled, s: r.severity, w: r.weight, p: r.params }, { e: d.enabled, s: d.severity, w: d.weight, p: d.params });
  }
});
