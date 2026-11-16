// GET /planner/versions/:id/diagnostics (contract 9.3). Needs a server at BASE_URL started with RUN_WORKERS=false PLANNER_ENABLED=true.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openSessions, newUid, scope, cleanup } from "./_util.js";
import { buildWorld, refreshSessions, S, ops, place, MON } from "./_editorUtil.js";

const s = scope(newUid());
let sessions;
let w;

before(async () => {
  sessions = await openSessions();
  w = await buildWorld(sessions.api, s);
});
after(() => cleanup(s, sessions));

const diag = () => w.api("GET", `/versions/${w.versionId}/diagnostics`);

async function generateAll() {
  const g = await w.api("POST", `/versions/${w.versionId}/generate`, {});
  assert.equal(g.status, 202, JSON.stringify(g.body));
  for (let i = 0; i < 100; i++) {
    const r = await w.api("GET", `/generation-runs/${g.body.run.id}`);
    if (r.body.run.status !== "queued" && r.body.run.status !== "running") return r.body.run;
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error("generation did not finish");
}

test("unknown version is 404 NOT_FOUND and non-admins are refused", async () => {
  const res = await w.api("GET", "/versions/00000000-0000-4000-8000-000000000000/diagnostics");
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "NOT_FOUND");
  assert.equal((await sessions.userApi("GET", `/versions/${w.versionId}/diagnostics`)).status, 403);
});

test("a fresh draft: every unplaced session is a hard all_placed issue, not publishable, shape and order per 9.3", async () => {
  const res = await diag();
  assert.equal(res.status, 200);
  const b = res.body;
  assert.equal(b.success, true);
  assert.equal(typeof b.rev, "number");
  assert.equal(b.publishable, false);
  assert.equal(b.counts.blocking, 0);
  assert.ok(b.counts.hard >= 1);
  assert.deepEqual(Object.keys(b.by_division).sort(), [w.X.id, w.Y.id].sort());
  assert.ok(b.by_division[w.X.id].hard >= 1);
  assert.equal(typeof b.by_division[w.X.id].soft, "number");
  const unplaced = b.issues.filter((i) => i.rule_key === "all_placed");
  const covered = new Set(unplaced.flatMap((i) => i.session_ids));
  assert.equal(covered.size, 9); // all 9 sessions of the world
  for (const i of unplaced) {
    assert.equal(i.severity, "hard");
    assert.equal(typeof i.id, "string");
    assert.ok(i.id.startsWith("all_placed:"));
    assert.equal(typeof i.message, "string");
    assert.ok(Array.isArray(i.session_ids));
    assert.ok("division_id" in i && "faculty_id" in i && "weekday" in i);
    assert.doesNotMatch(i.message, /[0-9a-f]{8}-[0-9a-f]{4}-/); // names, not ids
  }
  const rank = { blocking: 0, hard: 1, soft: 2 };
  const ranks = b.issues.map((i) => rank[i.severity]);
  assert.deepEqual(ranks, [...ranks].sort((a, c) => a - c));
  const ids = b.issues.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length); // ids are unique
  assert.deepEqual((await diag()).body.issues.map((i) => i.id), ids); // and deterministic
});

test("a placement made through /ops clears that session's all_placed issue and rev follows the snapshot", async () => {
  const sid = S(w, "Y", "TH1", "ALL", 1);
  const before = (await diag()).body;
  assert.ok(before.issues.some((i) => i.rule_key === "all_placed" && i.session_ids.includes(sid)));
  const r = await ops(w, [place(w, sid, MON, 510, w.rooms.classrooms[1])]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after2 = (await diag()).body;
  assert.equal(after2.rev, r.body.rev);
  assert.ok(after2.rev > before.rev);
  assert.equal(after2.issues.some((i) => i.rule_key === "all_placed" && i.session_ids.includes(sid)), false);
});

test("after generation everything is placed: no hard issue and publishable flips to true", async () => {
  const run = await generateAll();
  assert.equal(run.status, "succeeded", JSON.stringify(run));
  const b = (await diag()).body;
  assert.equal(b.counts.blocking, 0);
  assert.equal(b.counts.hard, 0, JSON.stringify(b.issues.filter((i) => i.severity === "hard").map((i) => i.message)));
  assert.equal(b.publishable, true);
  assert.equal(b.issues.filter((i) => i.rule_key === "all_placed").length, 0);
  assert.equal(b.by_division[w.X.id].hard, 0);
});

test("unplacing a session brings the hard issue back; disabling the rule hides it (rule config is live)", async () => {
  await refreshSessions(w);
  const sid = S(w, "X", "TH2");
  const un = await ops(w, [{ op: "unplace", session_id: sid }]);
  assert.equal(un.status, 200, JSON.stringify(un.body));
  const b = (await diag()).body;
  assert.equal(b.publishable, false);
  const issue = b.issues.find((i) => i.rule_key === "all_placed" && i.session_ids.includes(sid));
  assert.ok(issue, "all_placed issue for the unplaced session");
  assert.equal(issue.division_id, w.X.id);

  const off = await w.api("PATCH", `/terms/${w.termId}/rules`, { rules: [{ rule_key: "all_placed", enabled: false }] });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  const b2 = (await diag()).body;
  assert.equal(b2.issues.some((i) => i.rule_key === "all_placed"), false);
  assert.equal(b2.publishable, true);
  await w.api("POST", `/terms/${w.termId}/rules/reset`);
});
