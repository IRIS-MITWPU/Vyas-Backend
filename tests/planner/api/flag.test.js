// Planner API: with PLANNER_ENABLED != "true" the whole /planner router answers 404 {success:false,error:"Not found"}.
// Starts its own throwaway server (port 3199, RUN_WORKERS=false, PLANNER_ENABLED=false) and stops it afterwards.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { openSessions, pool } from "./_util.js";

const PORT = 3199;
const URL = `http://localhost:${PORT}`;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let server;
let sessions;

async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${URL}/health`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("flag-off test server did not start");
}

before(async () => {
  sessions = await openSessions();
  server = spawn(process.execPath, ["app.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), RUN_WORKERS: "false", PLANNER_ENABLED: "false" },
    stdio: "ignore",
  });
  await waitForHealth();
});

after(async () => {
  server?.kill();
  await sessions?.release();
  await pool.end();
});

const call = (method, p, cookie, body) =>
  fetch(`${URL}${p}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: URL, ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

test("flag off: every planner route is 404 {success:false,error:'Not found'}, even for an admin and before auth", async () => {
  for (const [m, p, b] of [
    ["GET", "/planner/health"], ["GET", "/planner/terms"], ["POST", "/planner/terms", { academic_year: "x", half: "odd" }],
    ["GET", "/planner/faculty"], ["GET", "/planner/available-rooms"], ["GET", "/planner/import-templates"],
    ["DELETE", "/planner/terms/00000000-0000-4000-8000-000000000000"],
    ["GET", "/planner/versions/00000000-0000-4000-8000-000000000000/snapshot"],
    ["POST", "/planner/versions/00000000-0000-4000-8000-000000000000/ops", { ops: [] }],
  ]) {
    const admin = await call(m, p, sessions.admin.cookie, b);
    assert.equal(admin.status, 404, `${m} ${p} (admin)`);
    assert.deepEqual(admin.body, { success: false, error: "Not found" });
    const anon = await call(m, p, undefined, b);
    assert.equal(anon.status, 404, `${m} ${p} (anonymous)`);
    assert.deepEqual(anon.body, { success: false, error: "Not found" });
  }
});

test("flag off: the rest of the API is unaffected", async () => {
  const res = await fetch(`${URL}/health`);
  assert.equal(res.status, 200);
});
