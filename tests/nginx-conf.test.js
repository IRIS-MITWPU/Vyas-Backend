// tests/nginx-conf.test.js — `npm run test:nginx`. Runs deploy/nginx-vyas.conf in an nginx container in front
// of a stub upstream. Needs Docker (skipped without it); not part of `npm test` because it pulls an image.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = "nginx:1.27-alpine";
const NAME = `vyas-nginx-test-${process.pid}`;
const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

let upstream, seen = [], nginxPort;

function request(reqPath, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: nginxPort, path: reqPath, method, headers: { host: "api.vyas.iris-club.in", ...headers } },
      (res) => { res.resume(); res.on("end", () => resolve(res)); },
    );
    req.on("error", reject);
    req.end(body);
  });
}

before(async () => {
  if (!hasDocker) return;
  upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => { seen.push({ url: req.url, headers: req.headers }); res.end("upstream ok"); });
  });
  await new Promise((r) => upstream.listen(0, "0.0.0.0", r));
  const conf = readFileSync(path.join(repo, "deploy", "nginx-vyas.conf"), "utf8")
    .replaceAll("http://127.0.0.1:3000", `http://host.docker.internal:${upstream.address().port}`);
  const file = path.join(mkdtempSync(path.join(tmpdir(), "vyas-nginx-")), "default.conf");
  writeFileSync(file, conf);
  const run = spawnSync("docker", [
    "run", "-d", "--rm", "--name", NAME, "-p", "127.0.0.1::80",
    "--add-host", "host.docker.internal:host-gateway",
    "-v", `${file}:/etc/nginx/conf.d/default.conf:ro`, IMAGE,
  ], { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  assert.equal(run.status, 0, run.stderr);
  const port = spawnSync("docker", ["port", NAME, "80/tcp"], { encoding: "utf8" }).stdout.trim().split(":").pop();
  nginxPort = Number(port);
  for (let i = 0; i < 40; i++) { // wait for nginx
    try { await request("/health"); return; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
});

after(async () => {
  if (!hasDocker) return;
  spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
  await new Promise((r) => upstream.close(r));
});

test("7.2 nginx -t accepts the config", { skip: !hasDocker }, () => {
  const r = spawnSync("docker", ["exec", NAME, "nginx", "-t"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("7.2 proxies /health with forwarded headers and no version banner", { skip: !hasDocker }, async () => {
  seen = [];
  const res = await request("/health");
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers.server, "nginx");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers["x-forwarded-proto"], "http");
  assert.ok(seen[0].headers["x-forwarded-for"], "x-forwarded-for reaches the app");
  assert.equal(seen[0].headers.host, "api.vyas.iris-club.in");
});

test("7.2 Bull Board is unreachable in every spelling", { skip: !hasDocker }, async () => {
  seen = [];
  for (const p of ["/admin/queues", "/admin/queues/", "/admin/queues/api/queues", "/ADMIN/QUEUES", "/Admin/Queues/x", "//admin/queues", "/%61dmin/queues", "/admin/queues?x=1"]) {
    const res = await request(p);
    assert.equal(res.statusCode, 404, `${p} -> ${res.statusCode}`);
  }
  assert.equal(seen.length, 0, "none of them reached the app");
  assert.equal((await request("/admin/other")).statusCode, 200); // only Bull Board is blocked
});

test("7.2 WebSocket upgrade headers are forwarded on /socket.io/", { skip: !hasDocker }, async () => {
  seen = [];
  await request("/socket.io/?EIO=4&transport=websocket", { headers: { upgrade: "websocket", connection: "Upgrade" } });
  assert.equal(seen[0].headers.upgrade, "websocket");
  assert.equal(seen[0].headers.connection, "upgrade");
});

test("7.2 request body limit is 50 MB", { skip: !hasDocker }, async () => {
  const big = await request("/booking", { method: "POST", body: Buffer.alloc(51 * 1024 * 1024) });
  assert.equal(big.statusCode, 413);
  const ok = await request("/booking", { method: "POST", body: Buffer.alloc(40 * 1024 * 1024) });
  assert.equal(ok.statusCode, 200);
});
