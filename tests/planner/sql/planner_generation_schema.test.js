// SQL-level tests for migration 017_planner_generation.sql (planner_generation_runs).
// Needs only the dev Postgres (no server). Every test runs in a transaction that is ROLLED BACK, so nothing
// persists (all rows use zz_planner_test_ academic years). Failing statements run inside a SAVEPOINT.
//
//   node --test tests/planner/sql/planner_generation_schema.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pool from "../../../database/db.js";

const dbDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "database");
const P = "zz_planner_test_";

after(async () => {
  await pool.end();
});

async function tx(fn) {
  assert.equal(process.env.DB_HOST, "localhost", "planner SQL tests must only run against a local DB");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

async function violates(c, code, constraint, sql, params = []) {
  await c.query("SAVEPOINT sp");
  try {
    await c.query(sql, params);
  } catch (err) {
    await c.query("ROLLBACK TO SAVEPOINT sp");
    assert.equal(err.code, code, `expected SQLSTATE ${code}, got ${err.code}: ${err.message}`);
    if (constraint) assert.equal(err.constraint, constraint, `constraint: ${err.message}`);
    return;
  }
  await c.query("ROLLBACK TO SAVEPOINT sp");
  assert.fail(`expected ${code}${constraint ? " " + constraint : ""} but statement succeeded: ${sql}`);
}

const one = async (c, sql, params) => (await c.query(sql, params)).rows[0];

let counter = 0;
async function mkVersion(c, termId) {
  const term = termId
    ? { id: termId }
    : await one(c, "INSERT INTO planner_terms (academic_year, half, branch) VALUES ($1,'odd','CSE') RETURNING *", [`${P}gen_${Date.now()}_${++counter}`]);
  // one draft per term: a second version of the same term is a historical one
  const version = await one(
    c, "INSERT INTO planner_versions (term_id, version_no, status) VALUES ($1, $2, $3) RETURNING *",
    [term.id, ++counter, termId ? "historical" : "draft"]
  );
  return { term, version };
}

const mkRun = (c, v, over = {}) =>
  one(
    c,
    `INSERT INTO planner_generation_runs (version_id, term_id, mode, status) VALUES ($1, $2, $3, $4) RETURNING *`,
    [v.version.id, v.term.id, over.mode ?? "fill_unplaced", over.status ?? "queued"]
  );

test("table, indexes and the migration record exist", async () => {
  const t = await pool.query("SELECT to_regclass('planner_generation_runs') AS t");
  assert.ok(t.rows[0].t);
  const { rows } = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'planner_generation_runs' ORDER BY indexname`
  );
  const names = rows.map((r) => r.indexname);
  for (const n of [
    "idx_planner_generation_runs_created_by", "idx_planner_generation_runs_term", "idx_planner_generation_runs_version",
    "planner_generation_runs_pkey", "uq_planner_generation_runs_active",
  ]) assert.ok(names.includes(n), `missing index ${n}`);
  const m = await pool.query("SELECT 1 FROM schema_migrations WHERE filename = '017_planner_generation.sql'");
  assert.equal(m.rowCount, 1);
});

test("defaults match the contract", async () => {
  await tx(async (c) => {
    const v = await mkVersion(c);
    const r = await mkRun(c, v);
    assert.equal(r.mode, "fill_unplaced");
    assert.equal(r.status, "queued");
    assert.equal(r.stage, null);
    assert.equal(r.progress_percent, 0);
    assert.equal(r.seed, 1);
    assert.deepEqual(r.scope, {});
    assert.deepEqual(r.options, {});
    assert.deepEqual(r.stats, {});
    assert.deepEqual(r.unplaced, []);
    assert.deepEqual(r.before_placements, []);
    assert.deepEqual(r.after_placements, []);
    assert.equal(r.after_rev, null);
    assert.equal(r.undone_at, null);
    assert.equal(r.error_code, null);
    assert.equal(r.error_message, null);
    assert.equal(r.created_by, null);
    assert.ok(r.created_at instanceof Date);
    assert.equal(r.started_at, null);
    assert.equal(r.finished_at, null);
    assert.match(r.id, /^[0-9a-f-]{36}$/);
  });
});

test("CHECK constraints: mode, status, progress_percent", async () => {
  await tx(async (c) => {
    const v = await mkVersion(c);
    const ins = "INSERT INTO planner_generation_runs (version_id, term_id, mode, status, progress_percent) VALUES ($1,$2,$3,$4,$5)";
    await violates(c, "23514", "planner_generation_runs_mode_check", ins, [v.version.id, v.term.id, "bogus", "failed", 0]);
    await violates(c, "23514", "planner_generation_runs_status_check", ins, [v.version.id, v.term.id, "fill_unplaced", "bogus", 0]);
    await violates(c, "23514", "planner_generation_runs_progress_check", ins, [v.version.id, v.term.id, "fill_unplaced", "failed", -1]);
    await violates(c, "23514", "planner_generation_runs_progress_check", ins, [v.version.id, v.term.id, "fill_unplaced", "failed", 101]);
    // every allowed value is accepted (finished statuses: the partial unique index does not apply)
    for (const mode of ["fill_unplaced", "regenerate_unlocked"]) {
      for (const status of ["succeeded", "failed", "cancelled"]) await c.query(ins, [v.version.id, v.term.id, mode, status, 100]);
    }
    await c.query(ins, [v.version.id, v.term.id, "fill_unplaced", "running", 0]);
    const n = await one(c, "SELECT count(*)::int AS n FROM planner_generation_runs WHERE version_id = $1", [v.version.id]);
    assert.equal(n.n, 7);
  });
});

test("NOT NULL / foreign keys: version and term must exist", async () => {
  await tx(async (c) => {
    const v = await mkVersion(c);
    const ghost = "00000000-0000-4000-8000-000000000000";
    await violates(c, "23503", "planner_generation_runs_version_id_fkey",
      "INSERT INTO planner_generation_runs (version_id, term_id, mode) VALUES ($1,$2,'fill_unplaced')", [ghost, v.term.id]);
    await violates(c, "23503", "planner_generation_runs_term_id_fkey",
      "INSERT INTO planner_generation_runs (version_id, term_id, mode) VALUES ($1,$2,'fill_unplaced')", [v.version.id, ghost]);
    await violates(c, "23502", null,
      "INSERT INTO planner_generation_runs (version_id, term_id, mode) VALUES ($1,$2,NULL)", [v.version.id, v.term.id]);
  });
});

test("partial unique index: one queued/running run per version, any number of finished ones", async () => {
  await tx(async (c) => {
    const v = await mkVersion(c);
    const ins = "INSERT INTO planner_generation_runs (version_id, term_id, mode, status) VALUES ($1,$2,'fill_unplaced',$3)";
    const idx = "uq_planner_generation_runs_active";

    // many finished runs coexist
    for (const status of ["succeeded", "succeeded", "failed", "failed", "cancelled", "cancelled"]) {
      await c.query(ins, [v.version.id, v.term.id, status]);
    }
    // one queued run is fine, a second queued or running one is not
    const q = await one(c, `${ins} RETURNING *`, [v.version.id, v.term.id, "queued"]);
    await violates(c, "23505", idx, ins, [v.version.id, v.term.id, "queued"]);
    await violates(c, "23505", idx, ins, [v.version.id, v.term.id, "running"]);
    // another version of the term (or another term) has its own slot
    const v2 = await mkVersion(c, v.term.id);
    await c.query(ins, [v2.version.id, v2.term.id, "running"]);
    const other = await mkVersion(c);
    await c.query(ins, [other.version.id, other.term.id, "queued"]);
    // finishing the active run frees the slot; running -> new queued run is refused again
    await c.query("UPDATE planner_generation_runs SET status = 'succeeded' WHERE id = $1", [q.id]);
    await c.query(ins, [v.version.id, v.term.id, "running"]);
    await violates(c, "23505", idx, ins, [v.version.id, v.term.id, "queued"]);
    // queued -> running transition of the one active run is not blocked by itself
    await c.query("UPDATE planner_generation_runs SET status = 'cancelled' WHERE version_id = $1 AND status = 'running'", [v.version.id]);
    const a = await one(c, `${ins} RETURNING id`, [v.version.id, v.term.id, "queued"]);
    await c.query("UPDATE planner_generation_runs SET status = 'running' WHERE id = $1", [a.id]);
    // un-finishing a finished run while another is active is refused too
    await violates(c, "23505", idx, "UPDATE planner_generation_runs SET status = 'queued' WHERE version_id = $1 AND status = 'failed'", [v.version.id]);
  });
});

test("deleting a version or its term cascades to its runs; deleting the creator only nulls created_by", async () => {
  await tx(async (c) => {
    const a = await mkVersion(c);
    const b = await mkVersion(c);
    await mkRun(c, a, { status: "succeeded" });
    await mkRun(c, a, { status: "failed" });
    await mkRun(c, b, { status: "succeeded" });
    const count = async (versionId) =>
      (await one(c, "SELECT count(*)::int AS n FROM planner_generation_runs WHERE version_id = $1", [versionId])).n;
    assert.equal(await count(a.version.id), 2);
    await c.query("DELETE FROM planner_versions WHERE id = $1", [a.version.id]);
    assert.equal(await count(a.version.id), 0);
    assert.equal(await count(b.version.id), 1);
    await c.query("DELETE FROM planner_terms WHERE id = $1", [b.term.id]);
    assert.equal(await count(b.version.id), 0);

    // created_by: ON DELETE SET NULL (a throwaway profile created inside the rolled-back transaction)
    const c1 = await mkVersion(c);
    const profile = await one(
      c, "INSERT INTO profiles (id, email, full_name) VALUES (gen_random_uuid(), $1, 'zz planner gen test') RETURNING id",
      [`${P}gen_${Date.now()}@mitwpu.edu.in`]
    );
    const run = await one(
      c, "INSERT INTO planner_generation_runs (version_id, term_id, mode, created_by) VALUES ($1,$2,'fill_unplaced',$3) RETURNING *",
      [c1.version.id, c1.term.id, profile.id]
    );
    assert.equal(run.created_by, profile.id);
    await c.query("DELETE FROM profiles WHERE id = $1", [profile.id]);
    const after = await one(c, "SELECT created_by FROM planner_generation_runs WHERE id = $1", [run.id]);
    assert.equal(after.created_by, null);
  });
});

test("applying migration 017 a second time is a no-op (data and structure unchanged)", async () => {
  const sql = await readFile(path.join(dbDir, "migrations", "017_planner_generation.sql"), "utf8");
  await tx(async (c) => {
    const v = await mkVersion(c);
    const r = await mkRun(c, v, { status: "succeeded" });
    const snapshot = async () => ({
      cons: (await c.query("SELECT conname, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'planner_generation_runs'::regclass ORDER BY conname")).rows,
      idx: (await c.query("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'planner_generation_runs' ORDER BY indexname")).rows,
      cols: (await c.query("SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'planner_generation_runs' ORDER BY ordinal_position")).rows,
    });
    const before = await snapshot();
    await c.query(sql);
    await c.query(sql);
    assert.deepEqual(await snapshot(), before);
    const still = await one(c, "SELECT id FROM planner_generation_runs WHERE id = $1", [r.id]);
    assert.equal(still.id, r.id);
  });
});

test("migration 018 (heartbeat_at, cancel_requested, instance_id): columns exist with the right shape, defaults for old rows, and applying it twice is a no-op", async () => {
  const sql = await readFile(path.join(dbDir, "migrations", "018_planner_generation_heartbeat.sql"), "utf8");
  await tx(async (c) => {
    const cols = (await c.query(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'planner_generation_runs' AND column_name IN ('heartbeat_at', 'cancel_requested', 'instance_id') ORDER BY column_name`
    )).rows;
    assert.deepEqual(cols.map((x) => [x.column_name, x.data_type, x.is_nullable]), [
      ["cancel_requested", "boolean", "NO"],
      ["heartbeat_at", "timestamp with time zone", "YES"],
      ["instance_id", "text", "YES"],
    ]);
    assert.match(cols[0].column_default, /false/i);

    const v = await mkVersion(c);
    const r = await mkRun(c, v, { status: "succeeded" });
    const row = await one(c, "SELECT heartbeat_at, cancel_requested, instance_id FROM planner_generation_runs WHERE id = $1", [r.id]);
    assert.deepEqual([row.heartbeat_at, row.cancel_requested, row.instance_id], [null, false, null]);

    const snapshot = async () => ({
      cols: (await c.query("SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'planner_generation_runs' ORDER BY ordinal_position")).rows,
      idx: (await c.query("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'planner_generation_runs' ORDER BY indexname")).rows,
    });
    const before = await snapshot();
    await c.query(sql);
    await c.query(sql);
    assert.deepEqual(await snapshot(), before);
    // the backfill only touches rows without a heartbeat and never fails: the row now has heartbeat = started/created
    const after = await one(c, "SELECT heartbeat_at, created_at FROM planner_generation_runs WHERE id = $1", [r.id]);
    assert.ok(after.heartbeat_at);
    // and a written heartbeat survives a re-run
    await c.query("UPDATE planner_generation_runs SET heartbeat_at = NOW() + interval '1 hour' WHERE id = $1", [r.id]);
    const written = await one(c, "SELECT heartbeat_at FROM planner_generation_runs WHERE id = $1", [r.id]);
    await c.query(sql);
    assert.equal((await one(c, "SELECT heartbeat_at FROM planner_generation_runs WHERE id = $1", [r.id])).heartbeat_at.getTime(), written.heartbeat_at.getTime());
  });
});
