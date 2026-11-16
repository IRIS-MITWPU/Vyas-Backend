// /planner/terms/:id/rules (contract 9.7). Needs a server at BASE_URL started with RUN_WORKERS=false PLANNER_ENABLED=true.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openSessions, newUid, scope, cleanup, makeTerm, fieldErrorsOf, pool } from "./_util.js";
import { DEFAULT_RULES, RULE_ORDER } from "../../../services/planner/domain/index.js";

const s = scope(newUid());
let sessions;
let api;
let term;

before(async () => {
  sessions = await openSessions();
  api = sessions.api;
  term = await makeTerm(api, s);
});
after(() => cleanup(s, sessions));

const rulesOf = (res) => Object.fromEntries(res.body.rules.map((r) => [r.rule_key, r]));
const storedCount = async (termId) => (await pool.query("SELECT count(*)::int AS n FROM planner_rule_config WHERE term_id = $1", [termId])).rows[0].n;
const NOPE = "00000000-0000-4000-8000-000000000000";

test("GET returns the 23 rules in spec order with their spec", async () => {
  const res = await api("GET", `/terms/${term.id}/rules`);
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.rules.length, 23);
  assert.deepEqual(res.body.rules.map((r) => r.rule_key), RULE_ORDER);
  for (const r of res.body.rules) {
    assert.equal(typeof r.enabled, "boolean");
    assert.ok(["blocking", "hard", "soft"].includes(r.severity));
    assert.ok(Number.isInteger(r.weight));
    assert.equal(typeof r.params, "object");
    assert.equal(typeof r.spec.label, "string");
    assert.ok(["blocking", "hard", "soft"].includes(r.spec.group));
    assert.ok(Array.isArray(r.spec.allowed_severities));
    assert.equal(typeof r.spec.params, "object");
    assert.equal(r.spec.zod, undefined);
  }
  const m = rulesOf(res);
  assert.equal(m.faculty_clash.severity, "blocking");
  assert.equal(m.faculty_consecutive.spec.params.n.max, 12);
  for (const d of DEFAULT_RULES) assert.equal(m[d.rule_key].severity, d.severity);
});

test("unknown and malformed term ids are 404; non-admins are refused", async () => {
  assert.equal((await api("GET", `/terms/${NOPE}/rules`)).status, 404);
  assert.equal((await api("PATCH", `/terms/${NOPE}/rules`, { rules: [{ rule_key: "day_balance", weight: 2 }] })).status, 404);
  assert.equal((await api("POST", `/terms/${NOPE}/rules/reset`)).status, 404);
  assert.equal((await api("GET", "/terms/not-a-uuid/rules")).status, 404);
  assert.equal((await sessions.userApi("GET", `/terms/${term.id}/rules`)).status, 403);
});

test("PATCH changes severity, weight, enabled and params (params merge) and the next GET shows them", async () => {
  const res = await api("PATCH", `/terms/${term.id}/rules`, {
    rules: [
      { rule_key: "faculty_consecutive", severity: "hard", params: { n: 4 } },
      { rule_key: "day_balance", enabled: false, weight: 7 },
      { rule_key: "time_of_day", params: { core_start: 600 } },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.rules.length, 23);
  const m = rulesOf(res);
  assert.equal(m.faculty_consecutive.severity, "hard");
  assert.deepEqual(m.faculty_consecutive.params, { n: 4 });
  assert.equal(m.day_balance.enabled, false);
  assert.equal(m.day_balance.weight, 7);
  assert.deepEqual(m.time_of_day.params, { core_start: 600, core_end: 930, late_start: 945 }); // merged over the stored params
  const again = rulesOf(await api("GET", `/terms/${term.id}/rules`));
  assert.deepEqual(again.faculty_consecutive.params, { n: 4 });
  assert.equal(again.day_balance.enabled, false);
});

test("PATCH validation errors carry fieldErrors keyed rules.<i>.<field>; the request is all-or-nothing", async () => {
  const before = rulesOf(await api("GET", `/terms/${term.id}/rules`));
  const res = await api("PATCH", `/terms/${term.id}/rules`, {
    rules: [
      { rule_key: "room_change", weight: 9 }, // valid
      { rule_key: "no_such_rule", weight: 1 },
      { rule_key: "faculty_consecutive", params: { n: 99 } },
      { rule_key: "student_consecutive", severity: "blocking" },
      { rule_key: "day_balance", weight: 11 },
    ],
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "VALIDATION_ERROR");
  const fe = fieldErrorsOf(res);
  assert.ok(fe["rules.1.rule_key"], JSON.stringify(fe));
  assert.ok(fe["rules.2.params.n"], JSON.stringify(fe));
  assert.ok(fe["rules.3.severity"], JSON.stringify(fe));
  assert.ok(fe["rules.4.weight"], JSON.stringify(fe));
  assert.equal(Object.keys(fe).some((k) => k.startsWith("rules.0.")), false);
  const after = rulesOf(await api("GET", `/terms/${term.id}/rules`));
  assert.equal(after.room_change.weight, before.room_change.weight); // the valid entry was not applied
});

test("PATCH body shape: empty list, too many rules and a duplicate key are 400", async () => {
  assert.equal((await api("PATCH", `/terms/${term.id}/rules`, { rules: [] })).status, 400);
  assert.equal((await api("PATCH", `/terms/${term.id}/rules`, {})).status, 400);
  const many = Array.from({ length: 31 }, () => ({ rule_key: "day_balance", weight: 1 }));
  assert.equal((await api("PATCH", `/terms/${term.id}/rules`, { rules: many })).status, 400);
  const dup = await api("PATCH", `/terms/${term.id}/rules`, { rules: [{ rule_key: "day_balance", weight: 1 }, { rule_key: "day_balance", weight: 2 }] });
  assert.equal(dup.status, 400);
  assert.ok(fieldErrorsOf(dup)["rules.1.rule_key"]);
});

test("blocking rules are immutable: any change is a 400, an echo of the fixed values is accepted", async () => {
  for (const patch of [{ enabled: false }, { severity: "soft" }, { weight: 5 }]) {
    const res = await api("PATCH", `/terms/${term.id}/rules`, { rules: [{ rule_key: "faculty_clash", ...patch }] });
    assert.equal(res.status, 400, JSON.stringify(patch));
    assert.ok(Object.keys(fieldErrorsOf(res)).some((k) => k.startsWith("rules.0.")));
  }
  const echo = await api("PATCH", `/terms/${term.id}/rules`, { rules: [{ rule_key: "faculty_clash", enabled: true, severity: "blocking" }] });
  assert.equal(echo.status, 200, JSON.stringify(echo.body));
  assert.equal(rulesOf(echo).faculty_clash.severity, "blocking");
});

test("upsert: a rule key the term has no stored row for is created by PATCH (existing terms only stored 19 rows)", async () => {
  await pool.query("DELETE FROM planner_rule_config WHERE term_id = $1 AND rule_key IN ('time_of_day', 'division_daily_hours')", [term.id]);
  const read = rulesOf(await api("GET", `/terms/${term.id}/rules`));
  assert.equal(read.time_of_day.severity, "soft"); // read from the defaults
  assert.equal(read.division_daily_hours.params.max_hours, 6);
  const res = await api("PATCH", `/terms/${term.id}/rules`, { rules: [{ rule_key: "division_daily_hours", params: { max_hours: 5 }, weight: 3 }] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(rulesOf(res).division_daily_hours.params, { max_hours: 5 });
  const { rows } = await pool.query("SELECT weight, params FROM planner_rule_config WHERE term_id = $1 AND rule_key = 'division_daily_hours'", [term.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].weight, 3);
  assert.deepEqual(rows[0].params, { max_hours: 5 });
});

test("reset restores every rule to the defaults and stores all 23 rows", async () => {
  const res = await api("POST", `/terms/${term.id}/rules/reset`);
  assert.equal(res.status, 200);
  assert.equal(res.body.rules.length, 23);
  const m = rulesOf(res);
  for (const d of DEFAULT_RULES) {
    assert.equal(m[d.rule_key].enabled, d.enabled, d.rule_key);
    assert.equal(m[d.rule_key].severity, d.severity, d.rule_key);
    assert.equal(m[d.rule_key].weight, d.weight, d.rule_key);
    assert.deepEqual(m[d.rule_key].params, d.params, d.rule_key);
  }
  assert.equal(await storedCount(term.id), 23);
  const again = rulesOf(await api("GET", `/terms/${term.id}/rules`));
  assert.equal(again.faculty_consecutive.severity, "soft");
});
