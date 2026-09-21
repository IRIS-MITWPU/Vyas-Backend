// tests/create-admin.test.js — scripts/create-admin.mjs against the dev Postgres (run via `npm test`)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import pool from "../database/db.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = Date.now();
const emails = [];

function run(env) {
  const r = spawnSync(process.execPath, ["scripts/create-admin.mjs"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ADMIN_EMAIL: "", ADMIN_PASSWORD: "", ADMIN_NAME: "", ADMIN_RESET_PASSWORD: "", ...env },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

async function row(email) {
  const { rows } = await pool.query(
    `SELECT p.is_admin, p.email_verified, a.password_hash FROM profiles p
       LEFT JOIN user_auth a ON a.user_id = p.id WHERE p.email = $1`,
    [email],
  );
  return rows[0];
}

after(async () => {
  if (emails.length) await pool.query("DELETE FROM profiles WHERE email = ANY($1)", [emails]);
  await pool.end();
});

test("6.8 create-admin: creates a verified admin, idempotent, never logs the password", async () => {
  const email = `ca-new-${stamp}@example.test`;
  emails.push(email);
  const r1 = run({ ADMIN_EMAIL: email, ADMIN_PASSWORD: "First-pass-1", ADMIN_NAME: "Root" });
  assert.equal(r1.code, 0, r1.out);
  assert.doesNotMatch(r1.out, /First-pass-1/);
  const a = await row(email);
  assert.equal(a.is_admin, true);
  assert.equal(a.email_verified, true);
  assert.ok(await bcrypt.compare("First-pass-1", a.password_hash));

  // second run with a different password: no-op for the password
  const r2 = run({ ADMIN_EMAIL: email, ADMIN_PASSWORD: "Other-pass-22" });
  assert.equal(r2.code, 0, r2.out);
  assert.ok(await bcrypt.compare("First-pass-1", (await row(email)).password_hash));

  // explicit reset
  const r3 = run({ ADMIN_EMAIL: email, ADMIN_PASSWORD: "Other-pass-22", ADMIN_RESET_PASSWORD: "1" });
  assert.equal(r3.code, 0, r3.out);
  assert.ok(await bcrypt.compare("Other-pass-22", (await row(email)).password_hash));
});

test("6.8 create-admin: promotes an existing user without touching their password", async () => {
  const email = `ca-existing-${stamp}@example.test`;
  emails.push(email);
  const hash = await bcrypt.hash("Users-own-pw-1", 10);
  const { rows: [p] } = await pool.query(
    "INSERT INTO profiles (full_name, email) VALUES ('Existing', $1) RETURNING id",
    [email],
  );
  await pool.query("INSERT INTO user_auth (user_id, password_hash) VALUES ($1, $2)", [p.id, hash]);

  const r = run({ ADMIN_EMAIL: email, ADMIN_PASSWORD: "Ignored-pass-9" });
  assert.equal(r.code, 0, r.out);
  const a = await row(email);
  assert.equal(a.is_admin, true);
  assert.equal(a.email_verified, true);
  assert.ok(await bcrypt.compare("Users-own-pw-1", a.password_hash));
});

test("6.8 create-admin: refuses missing input and weak passwords", async () => {
  const email = `ca-bad-${stamp}@example.test`;
  emails.push(email);
  assert.notEqual(run({ ADMIN_EMAIL: email }).code, 0);
  assert.notEqual(run({ ADMIN_EMAIL: email, ADMIN_PASSWORD: "short" }).code, 0);
  assert.notEqual(run({ ADMIN_EMAIL: "not-an-email", ADMIN_PASSWORD: "Long-enough-1" }).code, 0);
  assert.equal(await row(email), undefined);
});
