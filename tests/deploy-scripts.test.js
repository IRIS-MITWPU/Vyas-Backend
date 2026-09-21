// tests/deploy-scripts.test.js — the go/no-go log gate (deploy/check.sh --logs-only) against fabricated logs.
// Skipped when bash isn't available.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
const tmp = mkdtempSync(path.join(tmpdir(), "vyas-check-"));

const GOOD_APP = `✅ Connected to PostgreSQL database
✅ Socket.IO using Redis adapter (horizontal scaling enabled)
Background workers disabled (RUN_WORKERS=false) — run worker.js
Server listening on 3000
`;
const GOOD_WORKER = `✅ Connected to PostgreSQL database
📬 Email worker started
📥 Timetable import worker started
`;

function gate(app, worker) {
  const a = path.join(tmp, "app.log");
  const w = path.join(tmp, "worker.log");
  writeFileSync(a, app);
  writeFileSync(w, worker);
  // Normalise to a POSIX path for bash on Windows (C:\x -> /c/x).
  const posix = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  const r = spawnSync("bash", [posix(path.join(repo, "deploy", "check.sh")), "--logs-only"], {
    encoding: "utf8",
    env: { ...process.env, APP_LOG: posix(a), WORKER_LOG: posix(w) },
  });
  return { code: r.status, out: r.stdout };
}

test("6.9 check.sh: a healthy deploy is GO", { skip: !hasBash }, () => {
  const r = gate(GOOD_APP, GOOD_WORKER);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /GO/);
});

const bad = {
  "in-memory Socket.IO adapter": [GOOD_APP.replace("Socket.IO using Redis adapter", "REDIS_URL not set — Socket.IO using in-memory adapter"), GOOD_WORKER],
  "rate limiter store init error (limiter OFF)": [GOOD_APP + "express-rate-limit: async error during store initialization\n", GOOD_WORKER],
  "workers running inside app": [GOOD_APP.replace("Background workers disabled", "📬 Email worker started"), GOOD_WORKER],
  "import worker missing from worker": [GOOD_APP, GOOD_WORKER.replace("📥 Timetable import worker started\n", "")],
  "redis reconnect loop": [GOOD_APP + "Error: connect ECONNREFUSED 172.18.0.2:6379\n".repeat(6), GOOD_WORKER],
};
for (const [name, [app, worker]] of Object.entries(bad)) {
  test(`6.9 check.sh: NO-GO on ${name}`, { skip: !hasBash }, () => {
    const r = gate(app, worker);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /NO-GO/);
    assert.match(r.out, /FAIL/);
  });
}
