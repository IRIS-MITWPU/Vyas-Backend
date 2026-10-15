// tests/create-admin.test.js — scripts/create-admin.mjs against the dev Postgres (run via `npm test`)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pool from "../database/db.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = Date.now();
const emails = [];

function run(env) {
  const r = spawnSync(process.execPath, ["scripts/create-admin.mjs"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ADMIN_EMAIL: "", ADMIN_NAME: "", ...env },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

async function row(email) {
  const { rows } = await pool.query(
    "SELECT full_name, is_admin, email_verified FROM profiles WHERE email = $1",
    [email],
  );
  return rows[0];
}

after(async () => {
  if (emails.length) await pool.query("DELETE FROM profiles WHERE email = ANY($1)", [emails]);
  await pool.end();
});

test("6.8 create-admin: creates a verified admin (no password involved) and is idempotent", async () => {
  const email = `ca-new-${stamp}@mitwpu.edu.in`;
  emails.push(email);
  const r1 = run({ ADMIN_EMAIL: email, ADMIN_NAME: "Root" });
  assert.equal(r1.code, 0, r1.out);
  const a = await row(email);
  assert.equal(a.is_admin, true);
  assert.equal(a.email_verified, true);
  assert.equal(a.full_name, "Root");

  const r2 = run({ ADMIN_EMAIL: email.toUpperCase(), ADMIN_NAME: "Someone Else" });
  assert.equal(r2.code, 0, r2.out);
  assert.equal((await row(email)).full_name, "Root", "a second run changes nothing");
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM profiles WHERE lower(email) = $1", [email]);
  assert.equal(rows[0].n, 1);
});

test("6.8 create-admin: promotes an existing user without touching their name", async () => {
  const email = `ca-existing-${stamp}@mitwpu.edu.in`;
  emails.push(email);
  await pool.query("INSERT INTO profiles (full_name, email) VALUES ('Existing', $1)", [email]);

  const r = run({ ADMIN_EMAIL: email, ADMIN_NAME: "Ignored" });
  assert.equal(r.code, 0, r.out);
  const a = await row(email);
  assert.equal(a.is_admin, true);
  assert.equal(a.email_verified, true);
  assert.equal(a.full_name, "Existing");
});

test("6.8 create-admin: refuses missing or non-@mitwpu.edu.in input", async () => {
  const email = `ca-bad-${stamp}@example.test`;
  emails.push(email);
  assert.notEqual(run({}).code, 0);
  assert.notEqual(run({ ADMIN_EMAIL: email }).code, 0);
  assert.notEqual(run({ ADMIN_EMAIL: "not-an-email" }).code, 0);
  assert.equal(await row(email), undefined);
});
