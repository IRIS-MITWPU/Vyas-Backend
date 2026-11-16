// SQL-level tests for migration 015_planner_core.sql and 016_planner_lab_sharing.sql.
// Needs only the dev Postgres (no server). Every test runs in a transaction that is
// ROLLED BACK, so nothing persists. Failing statements run inside a SAVEPOINT so
// the surrounding transaction stays usable.
//
//   node --test tests/planner/sql
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import pool from "../../../database/db.js";

const dbDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "database");

const P = "zz_planner_test_";
let ROOMS = [];

before(async () => {
  assert.equal(process.env.DB_HOST, "localhost", "planner SQL tests must only run against a local DB");
  const { rows } = await pool.query(
    `SELECT id FROM rooms ORDER BY created_at, id LIMIT 3`
  );
  assert.ok(rows.length >= 2, "need at least 2 rooms in the dev DB");
  ROOMS = rows.map((r) => r.id);
});

after(async () => {
  await pool.end();
});

/** Run fn(client) in a transaction that is always rolled back. */
async function tx(fn) {
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

/** Expect `sql` to fail with the given SQLSTATE (and optional constraint name). */
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

/** Expect `sql` to succeed (inside a savepoint that is released). */
async function ok(c, sql, params = []) {
  return c.query(sql, params);
}

const one = async (c, sql, params) => (await c.query(sql, params)).rows[0];

let counter = 0;
const uniq = (s) => `${P}${s}_${++counter}`;

async function mkTerm(c, over = {}) {
  const t = {
    academic_year: `${P}2099-${++counter}`,
    half: "odd",
    branch: "CSE",
    ...over,
  };
  return one(
    c,
    `INSERT INTO planner_terms (academic_year, half, branch) VALUES ($1,$2,$3) RETURNING *`,
    [t.academic_year, t.half, t.branch]
  );
}

/** A minimal full fixture: term, draft version, division (+ whole, A, B batches),
 *  subject, offering, 2 faculty, 2 real rooms. */
async function fixture(c) {
  const term = await mkTerm(c);
  const version = await one(
    c,
    `INSERT INTO planner_versions (term_id, version_no) VALUES ($1, 1) RETURNING *`,
    [term.id]
  );
  const division = await one(
    c,
    `INSERT INTO planner_divisions (term_id, semester, name, student_count) VALUES ($1, 3, 'A', 60) RETURNING *`,
    [term.id]
  );
  const whole = await one(
    c,
    `INSERT INTO planner_batches (division_id, name, student_count, is_whole) VALUES ($1,'ALL',60,true) RETURNING *`,
    [division.id]
  );
  const batchA = await one(
    c,
    `INSERT INTO planner_batches (division_id, name, student_count) VALUES ($1,'A1',30) RETURNING *`,
    [division.id]
  );
  const batchB = await one(
    c,
    `INSERT INTO planner_batches (division_id, name, student_count) VALUES ($1,'A2',30) RETURNING *`,
    [division.id]
  );
  const subject = await one(
    c,
    `INSERT INTO planner_subjects (term_id, code, name, kind, duration_min) VALUES ($1,$2,'Test Subject','theory',60) RETURNING *`,
    [term.id, uniq("SUB")]
  );
  const offering = await one(
    c,
    `INSERT INTO planner_offerings (division_id, subject_id) VALUES ($1,$2) RETURNING *`,
    [division.id, subject.id]
  );
  const f1 = await one(
    c,
    `INSERT INTO planner_faculty (short_code, full_name) VALUES ($1,'Test F1') RETURNING *`,
    [uniq("F1")]
  );
  const f2 = await one(
    c,
    `INSERT INTO planner_faculty (short_code, full_name) VALUES ($1,'Test F2') RETURNING *`,
    [uniq("F2")]
  );
  return { term, version, division, whole, batchA, batchB, subject, offering, f1, f2, room1: ROOMS[0], room2: ROOMS[1] };
}

let seqCounter = 0;
/** Unplaced session helper (occupancy needs a session row). */
async function mkSession(c, fx, versionId = fx.version.id, batchId = fx.whole.id) {
  return one(
    c,
    `INSERT INTO planner_sessions (version_id, offering_id, batch_id, seq) VALUES ($1,$2,$3,$4) RETURNING *`,
    [versionId, fx.offering.id, batchId, ++seqCounter]
  );
}

async function occ(c, fx, { version = fx.version.id, kind, resource, weekday = 0, lo, hi, session }) {
  const s = session ?? (await mkSession(c, fx, version)).id;
  return one(
    c,
    `INSERT INTO planner_occupancy (version_id, session_id, kind, resource_id, weekday, during)
     VALUES ($1,$2,$3,$4,$5, int4range($6,$7,'[)')) RETURNING *`,
    [version, s, kind, resource, weekday, lo, hi]
  );
}

// ---------------------------------------------------------------------------
// Schema presence
// ---------------------------------------------------------------------------
test("all planner tables and migration record exist", async () => {
  const names = [
    "planner_terms", "planner_term_rooms", "planner_faculty", "planner_divisions", "planner_batches",
    "planner_subjects", "planner_offerings", "planner_offering_faculty", "planner_versions",
    "planner_sessions", "planner_session_faculty", "planner_occupancy", "planner_rule_config",
  ];
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`,
    [names]
  );
  assert.deepEqual(rows.map((r) => r.table_name).sort(), [...names].sort());
  const m = await pool.query(
    `SELECT filename FROM schema_migrations WHERE filename IN ('015_planner_core.sql', '016_planner_lab_sharing.sql')`
  );
  assert.equal(m.rowCount, 2);
});

test("defaults on planner_terms match the contract", async () => {
  await tx(async (c) => {
    const t = await mkTerm(c);
    assert.equal(t.branch, "CSE");
    assert.deepEqual(t.working_days, [0, 1, 2, 3, 4]);
    assert.equal(t.day_start_min, 510);
    assert.equal(t.day_end_min, 1065);
    assert.equal(t.grid_minutes, 15);
    assert.equal(t.theory_minutes, 60);
    assert.equal(t.lab_minutes, 120);
    assert.equal(t.breaks.length, 3);
    assert.equal(t.breaks[1].label, "Lunch");
    assert.equal(t.start_date, null);
    assert.equal(t.created_by, null);
  });
});

test("updated_at trigger fires on terms, faculty and sessions", async () => {
  await tx(async (c) => {
    const fx = await fixture(c);
    const s = await mkSession(c, fx);
    // inside one txn NOW() is constant, so push created_at into the past first
    await c.query(`UPDATE planner_terms SET created_at = created_at - interval '1 day', updated_at = updated_at - interval '1 day' WHERE id=$1`, [fx.term.id]);
    await c.query(`UPDATE planner_faculty SET updated_at = updated_at - interval '1 day' WHERE id=$1`, [fx.f1.id]);
    await c.query(`UPDATE planner_sessions SET updated_at = updated_at - interval '1 day' WHERE id=$1`, [s.id]);
    // the trigger also fires for those updates, so compare against a fresh NOW()
    const t = await one(c, `UPDATE planner_terms SET branch='ECE' WHERE id=$1 RETURNING updated_at >= NOW() AS fresh`, [fx.term.id]);
    const f = await one(c, `UPDATE planner_faculty SET department='X' WHERE id=$1 RETURNING updated_at >= NOW() AS fresh`, [fx.f1.id]);
    const ss = await one(c, `UPDATE planner_sessions SET locked=true WHERE id=$1 RETURNING updated_at >= NOW() AS fresh`, [s.id]);
    assert.ok(t.fresh && f.fresh && ss.fresh);
  });
});

// ---------------------------------------------------------------------------
// Exclusion constraint on planner_occupancy
// ---------------------------------------------------------------------------
for (const kind of ["faculty", "room", "batch"]) {
  test(`occupancy exclusion: overlapping ${kind} interval on same weekday+version is rejected`, async () => {
    await tx(async (c) => {
      const fx = await fixture(c);
      const res = { faculty: fx.f1.id, room: fx.room1, batch: fx.batchA.id }[kind];
      await occ(c, fx, { kind, resource: res, lo: 540, hi: 600 });
      // partial overlap, containment, identical
      for (const [lo, hi] of [[570, 630], [550, 560], [540, 600], [500, 541], [599, 700]]) {
        const s = await mkSession(c, fx);
        await violates(
          c, "23P01", "planner_occupancy_no_overlap",
          `INSERT INTO planner_occupancy (version_id, session_id, kind, resource_id, weekday, during)
           VALUES ($1,$2,$3,$4,0,int4range($5,$6,'[)'))`,
          [fx.version.id, s.id, kind, res, lo, hi]
        );
      }
    });
  });

  test(`occupancy exclusion: same ${kind} interval allowed for another resource / weekday / version / adjacent`, async () => {
    await tx(async (c) => {
      const fx = await fixture(c);
      const [r1, r2] = {
        faculty: [fx.f1.id, fx.f2.id],
        room: [fx.room1, fx.room2],
        batch: [fx.batchA.id, fx.batchB.id],
      }[kind];
      await occ(c, fx, { kind, resource: r1, lo: 540, hi: 600 });
      // different resource, same slot
      await occ(c, fx, { kind, resource: r2, lo: 540, hi: 600 });
      // different weekday
      await occ(c, fx, { kind, resource: r1, weekday: 1, lo: 540, hi: 600 });
      // adjacent intervals [540,600) | [600,660) and [480,540)
      await occ(c, fx, { kind, resource: r1, lo: 600, hi: 660 });
      await occ(c, fx, { kind, resource: r1, lo: 480, hi: 540 });
      // different version of the same term
      const v2 = await one(
        c,
        `INSERT INTO planner_versions (term_id, version_no, status) VALUES ($1, 2, 'published') RETURNING *`,
        [fx.term.id]
      );
      await occ(c, fx, { kind, resource: r1, version: v2.id, lo: 540, hi: 600 });
      const n = await one(c, `SELECT count(*)::int AS n FROM planner_occupancy WHERE kind=$1
          AND version_id IN (SELECT id FROM planner_versions WHERE term_id = $2)`, [kind, fx.term.id]); // scoped: other terms may hold real occupancy
      assert.equal(n.n, 6);
    });
  });
}

test("occupancy exclusion: same resource id under a different kind does not clash", async () => {
  await tx(async (c) => {
    const fx = await fixture(c);
    // contrived: same uuid used as faculty and room resource
    await occ(c, fx, { kind: "faculty", resource: fx.room1, lo: 540, hi: 600 });
    await occ(c, fx, { kind: "room", resource: fx.room1, lo: 540, hi: 600 });
  });
});

// ---- migration 016: shared lab rooms ('lab_room') ----

test("016: kind CHECK allows lab_room (and still rejects unknown kinds)", async () => {
  await tx(async (c) => {
    const fx = await fixture(c);
    const row = await occ(c, fx, { kind: "lab_room", resource: fx.room1, lo: 540, hi: 660 });
    assert.equal(row.kind, "lab_room");
    const sess = await mkSession(c, fx);
    const sql = `INSERT INTO planner_occupancy (version_id, session_id, kind, resource_id, weekday, during) VALUES ($1,$2,$3,$4,0,int4range(1,2))`;
    await violates(c, "23514", "planner_occupancy_kind_check", sql, [fx.version.id, sess.id, "lab", fx.room1]);
    await violates(c, "23514", "planner_occupancy_kind_check", sql, [fx.version.id, sess.id, "LAB_ROOM", fx.room1]);
  });
});

test("016: lab_room rows may overlap (identical, partial, contained); the exclusive kinds still may not", async () => {
  await tx(async (c) => {
    const fx = await fixture(c);
    for (const [lo, hi] of [[540, 660], [540, 660], [600, 720], [545, 555], [480, 900]]) {
      await occ(c, fx, { kind: "lab_room", resource: fx.room1, lo, hi });
    }
    const n = await one(c, `SELECT count(*)::int AS n FROM planner_occupancy WHERE kind = 'lab_room' AND resource_id = $1
          AND version_id IN (SELECT id FROM planner_versions WHERE term_id = $2)`, [fx.room1, fx.term.id]);
    assert.equal(n.n, 5);
    // the same ranges on the exclusive kinds are rejected
    for (const [kind, res] of [["faculty", fx.f1.id], ["room", fx.room2], ["batch", fx.batchA.id]]) {
      await occ(c, fx, { kind, resource: res, lo: 540, hi: 660 });
      const s2 = await mkSession(c, fx);
      await violates(c, "23P01", "planner_occupancy_no_overlap",
        `INSERT INTO planner_occupancy (version_id, session_id, kind, resource_id, weekday, during) VALUES ($1,$2,$3,$4,0,int4range(600,720,'[)'))`,
        [fx.version.id, s2.id, kind, res]);
    }
  });
});

test("016: a room row and a lab_room row on one resource are different kinds for the database (the editor service keeps them apart)", async () => {
  await tx(async (c) => {
    const fx = await fixture(c);
    await occ(c, fx, { kind: "room", resource: fx.room1, lo: 540, hi: 600 });
    await occ(c, fx, { kind: "lab_room", resource: fx.room1, lo: 540, hi: 600 });
    // two exclusive room rows in the same slot are still impossible
    const s2 = await mkSession(c, fx);
    await violates(c, "23P01", "planner_occupancy_no_overlap",
      `INSERT INTO planner_occupancy (version_id, session_id, kind, resource_id, weekday, during) VALUES ($1,$2,'room',$3,0,int4range(540,600,'[)'))`,
      [fx.version.id, s2.id, fx.room1]);
  });
});

function assertFinalOccupancyConstraints(kindCheck, noOverlap) {
  assert.ok(kindCheck, "kind check exists");
  for (const k of ["faculty", "room", "batch", "lab_room"]) assert.match(kindCheck.def, new RegExp(`'${k}'`), `kind check mentions ${k}`);
  assert.ok(noOverlap, "exclusion constraint exists");
  assert.match(noOverlap.def, /^EXCLUDE USING gist \(version_id WITH =, kind WITH =, resource_id WITH =, weekday WITH =, during WITH &&\)/);
  assert.match(noOverlap.def, /WHERE \(\(kind <> 'lab_room'::text\)\)/);
  assert.equal(noOverlap.condeferrable, true, "DEFERRABLE");
  assert.equal(noOverlap.condeferred, false, "INITIALLY IMMEDIATE");
}

test("016: the live constraint definitions (read only): predicate, same columns, DEFERRABLE INITIALLY IMMEDIATE", async () => {
  const { rows } = await pool.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def, condeferrable, condeferred
       FROM pg_constraint WHERE conrelid = 'planner_occupancy'::regclass AND conname IN ('planner_occupancy_no_overlap', 'planner_occupancy_kind_check')`
  );
  const by = Object.fromEntries(rows.map((r) => [r.conname, r]));
  assertFinalOccupancyConstraints(by.planner_occupancy_kind_check, by.planner_occupancy_no_overlap);
});

test("occupancy exclusion is DEFERRABLE: swapping two rows' resources in one txn works", async () => {
  await tx(async (c) => {
    const fx = await fixture(c);
    const a = await occ(c, fx, { kind: "faculty", resource: fx.f1.id, lo: 540, hi: 600 });
    const b = await occ(c, fx, { kind: "faculty", resource: fx.f2.id, lo: 540, hi: 600 });

    // IMMEDIATE (default): the first half of a swap already collides
    await violates(
      c, "23P01", "planner_occupancy_no_overlap",
      `UPDATE planner_occupancy SET resource_id=$1 WHERE id=$2`, [fx.f2.id, a.id]
    );

    // DEFERRED: swap, then validate at SET CONSTRAINTS ... IMMEDIATE
    await c.query(`SET CONSTRAINTS planner_occupancy_no_overlap DEFERRED`);
    await c.query(`UPDATE planner_occupancy SET resource_id=$1 WHERE id=$2`, [fx.f2.id, a.id]);
    await c.query(`UPDATE planner_occupancy SET resource_id=$1 WHERE id=$2`, [fx.f1.id, b.id]);
    await c.query(`SET CONSTRAINTS planner_occupancy_no_overlap IMMEDIATE`);
    const { rows } = await c.query(`SELECT id, resource_id FROM planner_occupancy WHERE id = ANY($1) ORDER BY id`, [[a.id, b.id]]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.resource_id]));
    assert.equal(byId[a.id], fx.f2.id);
    assert.equal(byId[b.id], fx.f1.id);
  });
});

test("occupancy exclusion deferred: a real overlap is still caught when constraints are checked", async () => {
  await tx(async (c) => {
    const fx = await fixture(c);
    await occ(c, fx, { kind: "room", resource: fx.room1, lo: 540, hi: 600 });
    const b = await occ(c, fx, { kind: "room", resource: fx.room2, lo: 540, hi: 600 });
    await c.query(`SET CONSTRAINTS planner_occupancy_no_overlap DEFERRED`);
    await c.query(`UPDATE planner_occupancy SET resource_id=$1 WHERE id=$2`, [fx.room1, b.id]); // now a true clash
    await violates(c, "23P01", "planner_occupancy_no_overlap", `SET CONSTRAINTS planner_occupancy_no_overlap IMMEDIATE`);
  });
});

test("occupancy: kind and weekday CHECKs", async () => {
  await tx(async (c) => {
    const fx = await fixture(c);
    const s = await mkSession(c, fx);
    await violates(c, "23514", "planner_occupancy_kind_check",
      `INSERT INTO planner_occupancy (version_id, session_id, kind, resource_id, weekday, during) VALUES ($1,$2,'bogus',$3,0,int4range(1,2))`,
      [fx.version.id, s.id, fx.f1.id]);
    await violates(c, "23514", "planner_occupancy_weekday_check",
      `INSERT INTO planner_occupancy (version_id, session_id, kind, resource_id, weekday, during) VALUES ($1,$2,'faculty',$3,7,int4range(1,2))`,
      [fx.version.id, s.id, fx.f1.id]);
  });
});

// ---------------------------------------------------------------------------
// CHECK constraints
// ---------------------------------------------------------------------------
test("planner_sessions: placement is all-or-none", async () => {
  await tx(async (c) => {
    const fx = await fixture(c);
    const ins = (vals) =>
      `INSERT INTO planner_sessions (version_id, offering_id, batch_id, seq, weekday, start_min, end_min, room_id)
       VALUES ($1,$2,$3,$4,${vals})`;
    const base = (seq) => [fx.version.id, fx.offering.id, fx.whole.id, seq];
    // fully placed and fully unplaced are fine
    await ok(c, ins(`1, 540, 600, $5`), [...base(10), fx.room1]);
    await ok(c, ins(`NULL, NULL, NULL, NULL`), base(11));
    // every partial combination is rejected
    const partials = [
      [`1, NULL, NULL, NULL`, []],
      [`NULL, 540, NULL, NULL`, []],
      [`NULL, NULL, 600, NULL`, []],
      [`NULL, NULL, NULL, $5`, [fx.room1]],
      [`1, 540, 600, NULL`, []],
      [`NULL, 540, 600, $5`, [fx.room1]],
      [`1, 540, NULL, $5`, [fx.room1]],
    ];
    let seq = 20;
    for (const [vals, extra] of partials) {
      await violates(c, "23514", "planner_sessions_placement_check", ins(vals), [...base(seq++), ...extra]);
    }
  });
});

test("planner_sessions: end>start, start%15, weekday range, seq>=1", async () => {
  await tx(async (c) => {
    const fx = await fixture(c);
    const ins = `INSERT INTO planner_sessions (version_id, offering_id, batch_id, seq, weekday, start_min, end_min, room_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;
    const mk = (seq, wd, s, e) => [fx.version.id, fx.offering.id, fx.whole.id, seq, wd, s, e, fx.room1];
    await ok(c, ins, mk(1, 6, 0, 15));                                            // boundaries ok
    await violates(c, "23514", "planner_sessions_time_order_check", ins, mk(2, 0, 600, 600));   // end == start
    await violates(c, "23514", "planner_sessions_time_order_check", ins, mk(3, 0, 600, 540));   // end < start
    await violates(c, "23514", "planner_sessions_grid_check", ins, mk(4, 0, 541, 600));         // off grid
    await violates(c, "23514", "planner_sessions_grid_check", ins, mk(5, 0, 545, 600));
    await ok(c, ins, mk(6, 0, 555, 600));                                         // 555 = 37*15 ok
    await violates(c, "23514", "planner_sessions_weekday_check", ins, mk(7, 7, 540, 600));
    await violates(c, "23514", "planner_sessions_weekday_check", ins, mk(8, -1, 540, 600));
    await violates(c, "23514", "planner_sessions_seq_check",
      `INSERT INTO planner_sessions (version_id, offering_id, batch_id, seq) VALUES ($1,$2,$3,0)`,
      [fx.version.id, fx.offering.id, fx.whole.id]);
  });
});

test("planner_terms CHECKs: day order, positive minutes, dates, working_days, half, breaks", async () => {
  await tx(async (c) => {
    const ins = (cols, vals) =>
      `INSERT INTO planner_terms (academic_year, half, ${cols}) VALUES ('${P}chk_${++counter}', 'odd', ${vals})`;
    await violates(c, "23514", "planner_terms_day_order_check", ins("day_start_min, day_end_min", "600, 600"));
    await violates(c, "23514", "planner_terms_day_order_check", ins("day_start_min, day_end_min", "700, 600"));
    await violates(c, "23514", "planner_terms_grid_check", ins("grid_minutes", "0"));
    await violates(c, "23514", "planner_terms_theory_check", ins("theory_minutes", "0"));
    await violates(c, "23514", "planner_terms_lab_check", ins("lab_minutes", "-5"));
    await violates(c, "23514", "planner_terms_dates_check", ins("start_date, end_date", "'2026-08-10', '2026-08-09'"));
    await ok(c, ins("start_date, end_date", "'2026-08-10', '2026-08-10'"));
    await ok(c, ins("start_date", "'2026-08-10'")); // only one date set is fine
    await violates(c, "23514", "planner_terms_working_days_check", ins("working_days", "'{}'::smallint[]"));
    await violates(c, "23514", "planner_terms_working_days_check", ins("working_days", "'{0,7}'::smallint[]"));
    await violates(c, "23514", "planner_terms_breaks_check", ins("breaks", `'{"a":1}'::jsonb`));
    await violates(c, "23514", "planner_terms_half_check",
      `INSERT INTO planner_terms (academic_year, half) VALUES ('${P}h', 'spring')`);
    await ok(c, ins("working_days", "'{0,1,2,3,4,5,6}'::smallint[]"));
  });
});

test("assorted CHECKs: faculty, divisions, batches, subjects, offerings, versions, offering_faculty, rule_config", async () => {
  await tx(async (c) => {
    const fx = await fixture(c);
    // faculty
    await violates(c, "23514", "planner_faculty_email_lower",
      `INSERT INTO planner_faculty (short_code, full_name, email) VALUES ($1,'x','Mixed@Case.com')`, [uniq("E")]);
    await ok(c, `INSERT INTO planner_faculty (short_code, full_name, email) VALUES ($1,'x','ok@case.com')`, [uniq("E")]);
    await violates(c, "23514", "planner_faculty_max_per_day_check",
      `INSERT INTO planner_faculty (short_code, full_name, max_per_day) VALUES ($1,'x',0)`, [uniq("M")]);
    await violates(c, "23514", "planner_faculty_max_per_week_check",
      `INSERT INTO planner_faculty (short_code, full_name, max_per_week) VALUES ($1,'x',0)`, [uniq("M")]);
    // divisions
    await violates(c, "23514", "planner_divisions_semester_check",
      `INSERT INTO planner_divisions (term_id, semester, name) VALUES ($1,0,'Z')`, [fx.term.id]);
    await violates(c, "23514", "planner_divisions_semester_check",
      `INSERT INTO planner_divisions (term_id, semester, name) VALUES ($1,13,'Z')`, [fx.term.id]);
    await violates(c, "23514", "planner_divisions_student_count_check",
      `INSERT INTO planner_divisions (term_id, semester, name, student_count) VALUES ($1,1,'Z',-1)`, [fx.term.id]);
    // batches
    await violates(c, "23514", "planner_batches_student_count_check",
      `INSERT INTO planner_batches (division_id, name, student_count) VALUES ($1,'Neg',-1)`, [fx.division.id]);
    // subjects
    const sub = (kind, dur, wc, st) =>
      [`INSERT INTO planner_subjects (term_id, code, name, kind, duration_min, weekly_count, semester_total) VALUES ($1,$2,'n',$3,$4,$5,$6)`,
       [fx.term.id, uniq("S"), kind, dur, wc, st]];
    await violates(c, "23514", "planner_subjects_kind_check", ...sub("seminar", 60, 1, null));
    await violates(c, "23514", "planner_subjects_duration_check", ...sub("theory", 0, 1, null));
    await violates(c, "23514", "planner_subjects_weekly_count_check", ...sub("theory", 60, -1, null));
    await violates(c, "23514", "planner_subjects_semester_total_check", ...sub("theory", 60, 1, -1));
    await ok(c, ...sub("lab", 120, 0, 0));
    // offerings
    const sub2 = await one(c, `INSERT INTO planner_subjects (term_id, code, name, kind, duration_min) VALUES ($1,$2,'n','lab',120) RETURNING id`, [fx.term.id, uniq("S")]);
    await violates(c, "23514", "planner_offerings_weekly_count_check",
      `INSERT INTO planner_offerings (division_id, subject_id, weekly_count) VALUES ($1,$2,-1)`, [fx.division.id, sub2.id]);
    // versions
    await violates(c, "23514", "planner_versions_status_check",
      `INSERT INTO planner_versions (term_id, version_no, status) VALUES ($1,9,'archived')`, [fx.term.id]);
    // offering_faculty role
    await violates(c, "23514", "planner_offering_faculty_role_check",
      `INSERT INTO planner_offering_faculty (offering_id, faculty_id, role) VALUES ($1,$2,'boss')`, [fx.offering.id, fx.f1.id]);
    await ok(c, `INSERT INTO planner_offering_faculty (offering_id, faculty_id) VALUES ($1,$2)`, [fx.offering.id, fx.f1.id]);
    const role = await one(c, `SELECT role FROM planner_offering_faculty WHERE offering_id=$1`, [fx.offering.id]);
    assert.equal(role.role, "lead"); // default
    // rule_config
    await violates(c, "23514", "planner_rule_config_severity_check",
      `INSERT INTO planner_rule_config (term_id, rule_key, severity) VALUES ($1,'k','meh')`, [fx.term.id]);
    const rc = await one(c, `INSERT INTO planner_rule_config (term_id, rule_key, severity) VALUES ($1,'k','soft') RETURNING *`, [fx.term.id]);
    assert.equal(rc.enabled, true);
    assert.equal(rc.weight, 1);
    assert.deepEqual(rc.params, {});
  });
});

// ---------------------------------------------------------------------------
// Uniqueness
// ---------------------------------------------------------------------------
test("unique: term (academic_year, half, branch)", async () => {
  await tx(async (c) => {
    const t = await mkTerm(c);
    await violates(c, "23505", "planner_terms_unique_term",
      `INSERT INTO planner_terms (academic_year, half, branch) VALUES ($1,$2,$3)`, [t.academic_year, t.half, t.branch]);
    await mkTerm(c, { academic_year: t.academic_year, half: "even" });        // other half ok
    await mkTerm(c, { academic_year: t.academic_year, branch: "ECE" });       // other branch ok
  });
});

test("unique: division (term, semester, name); subject (term, code); offering (division, subject)", async () => {
  await tx(async (c) => {
    const fx = await fixture(c);
    await violates(c, "23505", "planner_divisions_unique",
      `INSERT INTO planner_divisions (term_id, semester, name) VALUES ($1,3,'A')`, [fx.term.id]);
    await ok(c, `INSERT INTO planner_divisions (term_id, semester, name) VALUES ($1,4,'A')`, [fx.term.id]);
    await ok(c, `INSERT INTO planner_divisions (term_id, semester, name) VALUES ($1,3,'B')`, [fx.term.id]);
    const other = await mkTerm(c);
    await ok(c, `INSERT INTO planner_divisions (term_id, semester, name) VALUES ($1,3,'A')`, [other.id]); // other term ok

    await violates(c, "23505", "planner_subjects_unique",
      `INSERT INTO planner_subjects (term_id, code, name, kind, duration_min) VALUES ($1,$2,'dup','theory',60)`,
      [fx.term.id, fx.subject.code]);
    await ok(c, `INSERT INTO planner_subjects (term_id, code, name, kind, duration_min) VALUES ($1,$2,'same code other term','theory',60)`,
      [other.id, fx.subject.code]);

    await violates(c, "23505", "planner_offerings_unique",
      `INSERT INTO planner_offerings (division_id, subject_id) VALUES ($1,$2)`, [fx.division.id, fx.subject.id]);
  });
});

test("unique: faculty lower(short_code) and profile_id", async () => {
  await tx(async (c) => {
    const code = uniq("Fx");
    await ok(c, `INSERT INTO planner_faculty (short_code, full_name) VALUES ($1,'a')`, [code]);
    await violates(c, "23505", "uq_planner_faculty_short_code_lower",
      `INSERT INTO planner_faculty (short_code, full_name) VALUES ($1,'b')`, [code.toUpperCase()]);
    await violates(c, "23505", "uq_planner_faculty_short_code_lower",
      `INSERT INTO planner_faculty (short_code, full_name) VALUES ($1,'b')`, [code.toLowerCase()]);
    // one planner_faculty per profile (profile_id UNIQUE); multiple NULLs are fine
    const prof = await one(c, `SELECT id FROM profiles LIMIT 1`);
    if (prof) {
      await ok(c, `INSERT INTO planner_faculty (short_code, full_name, profile_id) VALUES ($1,'p1',$2)`, [uniq("P"), prof.id]);
      await violates(c, "23505", "planner_faculty_profile_unique",
        `INSERT INTO planner_faculty (short_code, full_name, profile_id) VALUES ($1,'p2',$2)`, [uniq("P"), prof.id]);
    }
    await ok(c, `INSERT INTO planner_faculty (short_code, full_name) VALUES ($1,'n1')`, [uniq("N")]);
    await ok(c, `INSERT INTO planner_faculty (short_code, full_name) VALUES ($1,'n2')`, [uniq("N")]);
  });
});

test("unique: batch name per division and exactly one whole batch per division", async () => {
  await tx(async (c) => {
    const fx = await fixture(c);
    await violates(c, "23505", "planner_batches_unique",
      `INSERT INTO planner_batches (division_id, name) VALUES ($1,'A1')`, [fx.division.id]);
    await violates(c, "23505", "uq_planner_batches_one_whole",
      `INSERT INTO planner_batches (division_id, name, is_whole) VALUES ($1,'ALL2',true)`, [fx.division.id]);
    // a second whole batch in a different division is fine
    const d2 = await one(c, `INSERT INTO planner_divisions (term_id, semester, name) VALUES ($1,3,'B') RETURNING id`, [fx.term.id]);
    await ok(c, `INSERT INTO planner_batches (division_id, name, is_whole) VALUES ($1,'ALL',true)`, [d2.id]);
  });
});

test("unique: offering_faculty (offering, COALESCE(batch), faculty) incl. NULL batch", async () => {
  await tx(async (c) => {
    const fx = await fixture(c);
    const ins = `INSERT INTO planner_offering_faculty (offering_id, batch_id, faculty_id) VALUES ($1,$2,$3)`;
    await ok(c, ins, [fx.offering.id, null, fx.f1.id]);
    await violates(c, "23505", "uq_planner_offering_faculty", ins, [fx.offering.id, null, fx.f1.id]); // NULL batch dup
    await ok(c, ins, [fx.offering.id, fx.batchA.id, fx.f1.id]);                                       // batch-specific ok
    await violates(c, "23505", "uq_planner_offering_faculty", ins, [fx.offering.id, fx.batchA.id, fx.f1.id]);
    await ok(c, ins, [fx.offering.id, null, fx.f2.id]);                                               // other faculty ok
  });
});

test("unique: one draft and one published version per term; version_no unique; many historical", async () => {
  await tx(async (c) => {
    const fx = await fixture(c); // v1 = draft
    await violates(c, "23505", "uq_planner_versions_one_draft",
      `INSERT INTO planner_versions (term_id, version_no, status) VALUES ($1,2,'draft')`, [fx.term.id]);
    await violates(c, "23505", "planner_versions_unique",
      `INSERT INTO planner_versions (term_id, version_no, status) VALUES ($1,1,'historical')`, [fx.term.id]);
    await ok(c, `INSERT INTO planner_versions (term_id, version_no, status) VALUES ($1,2,'published')`, [fx.term.id]);
    await violates(c, "23505", "uq_planner_versions_one_published",
      `INSERT INTO planner_versions (term_id, version_no, status) VALUES ($1,3,'published')`, [fx.term.id]);
    await ok(c, `INSERT INTO planner_versions (term_id, version_no, status) VALUES ($1,3,'historical')`, [fx.term.id]);
    await ok(c, `INSERT INTO planner_versions (term_id, version_no, status) VALUES ($1,4,'historical')`, [fx.term.id]);
    // another term can have its own draft
    const t2 = await mkTerm(c);
    await ok(c, `INSERT INTO planner_versions (term_id, version_no) VALUES ($1,1)`, [t2.id]);
  });
});

test("unique: session (version, offering, batch, seq); term_rooms (term, room); rule_config (term, key)", async () => {
  await tx(async (c) => {
    const fx = await fixture(c);
    const s = await mkSession(c, fx);
    await violates(c, "23505", "planner_sessions_unique",
      `INSERT INTO planner_sessions (version_id, offering_id, batch_id, seq) VALUES ($1,$2,$3,$4)`,
      [fx.version.id, fx.offering.id, fx.whole.id, s.seq]);
    await ok(c, `INSERT INTO planner_sessions (version_id, offering_id, batch_id, seq) VALUES ($1,$2,$3,$4)`,
      [fx.version.id, fx.offering.id, fx.batchA.id, s.seq]); // other batch, same seq ok

    await ok(c, `INSERT INTO planner_term_rooms (term_id, room_id, is_lab) VALUES ($1,$2,false)`, [fx.term.id, fx.room1]);
    await violates(c, "23505", "planner_term_rooms_unique",
      `INSERT INTO planner_term_rooms (term_id, room_id, is_lab) VALUES ($1,$2,true)`, [fx.term.id, fx.room1]);

    await ok(c, `INSERT INTO planner_rule_config (term_id, rule_key, severity) VALUES ($1,'faculty_clash','blocking')`, [fx.term.id]);
    await violates(c, "23505", "planner_rule_config_unique",
      `INSERT INTO planner_rule_config (term_id, rule_key, severity) VALUES ($1,'faculty_clash','soft')`, [fx.term.id]);

    // session_faculty primary key
    await ok(c, `INSERT INTO planner_session_faculty (session_id, faculty_id) VALUES ($1,$2)`, [s.id, fx.f1.id]);
    await violates(c, "23505", "planner_session_faculty_pkey",
      `INSERT INTO planner_session_faculty (session_id, faculty_id) VALUES ($1,$2)`, [s.id, fx.f1.id]);
  });
});

// ---------------------------------------------------------------------------
// ON DELETE behaviour (NO ACTION FKs surface as SQLSTATE 23503)
// ---------------------------------------------------------------------------
test("deleting a term cascades all children; global faculty and rooms survive", async () => {
  await tx(async (c) => {
    const fx = await fixture(c);
    const placed = await one(
      c,
      `INSERT INTO planner_sessions (version_id, offering_id, batch_id, seq, weekday, start_min, end_min, room_id)
       VALUES ($1,$2,$3,50,0,540,600,$4) RETURNING *`,
      [fx.version.id, fx.offering.id, fx.whole.id, fx.room1]
    );
    const unplaced = await mkSession(c, fx);
    await ok(c, `INSERT INTO planner_session_faculty (session_id, faculty_id) VALUES ($1,$2)`, [placed.id, fx.f1.id]);
    await occ(c, fx, { kind: "faculty", resource: fx.f1.id, lo: 540, hi: 600, session: placed.id });
    await ok(c, `INSERT INTO planner_offering_faculty (offering_id, faculty_id) VALUES ($1,$2)`, [fx.offering.id, fx.f1.id]);
    await ok(c, `INSERT INTO planner_term_rooms (term_id, room_id, is_lab) VALUES ($1,$2,false)`, [fx.term.id, fx.room1]);
    await ok(c, `INSERT INTO planner_rule_config (term_id, rule_key, severity) VALUES ($1,'faculty_clash','blocking')`, [fx.term.id]);
    void unplaced;

    await c.query(`DELETE FROM planner_terms WHERE id=$1`, [fx.term.id]);

    const counts = await one(
      c,
      `SELECT
         (SELECT count(*)::int FROM planner_versions         WHERE term_id=$1) AS versions,
         (SELECT count(*)::int FROM planner_divisions        WHERE term_id=$1) AS divisions,
         (SELECT count(*)::int FROM planner_subjects         WHERE term_id=$1) AS subjects,
         (SELECT count(*)::int FROM planner_term_rooms       WHERE term_id=$1) AS term_rooms,
         (SELECT count(*)::int FROM planner_rule_config      WHERE term_id=$1) AS rules,
         (SELECT count(*)::int FROM planner_batches          WHERE division_id=$2) AS batches,
         (SELECT count(*)::int FROM planner_offerings        WHERE division_id=$2) AS offerings,
         (SELECT count(*)::int FROM planner_offering_faculty WHERE offering_id=$3) AS offering_faculty,
         (SELECT count(*)::int FROM planner_sessions         WHERE version_id=$4) AS sessions,
         (SELECT count(*)::int FROM planner_session_faculty  WHERE session_id=$5) AS session_faculty,
         (SELECT count(*)::int FROM planner_occupancy        WHERE version_id=$4) AS occupancy,
         (SELECT count(*)::int FROM planner_faculty          WHERE id = ANY($6)) AS faculty_left,
         (SELECT count(*)::int FROM rooms                    WHERE id = ANY($7)) AS rooms_left`,
      [fx.term.id, fx.division.id, fx.offering.id, fx.version.id, placed.id, [fx.f1.id, fx.f2.id], [fx.room1, fx.room2]]
    );
    assert.deepEqual(counts, {
      versions: 0, divisions: 0, subjects: 0, term_rooms: 0, rules: 0, batches: 0, offerings: 0,
      offering_faculty: 0, sessions: 0, session_faculty: 0, occupancy: 0, faculty_left: 2, rooms_left: 2,
    });
  });
});

test("a placed session blocks deleting its room (NO ACTION)", async () => {
  await tx(async (c) => {
    const fx = await fixture(c);
    await ok(
      c,
      `INSERT INTO planner_sessions (version_id, offering_id, batch_id, seq, weekday, start_min, end_min, room_id)
       VALUES ($1,$2,$3,1,0,540,600,$4)`,
      [fx.version.id, fx.offering.id, fx.whole.id, fx.room1]
    );
    await violates(c, "23503", "planner_sessions_room_id_fkey", `DELETE FROM rooms WHERE id=$1`, [fx.room1]);
    // rows are intact
    const n = await one(c, `SELECT count(*)::int AS n FROM planner_sessions WHERE room_id=$1`, [fx.room1]);
    assert.equal(n.n, 1);
  });
});

test("NO ACTION: sessions block deleting their offering/batch; faculty in use cannot be deleted", async () => {
  await tx(async (c) => {
    const fx = await fixture(c);
    const s = await mkSession(c, fx);
    await violates(c, "23503", "planner_sessions_offering_id_fkey", `DELETE FROM planner_offerings WHERE id=$1`, [fx.offering.id]);
    await violates(c, "23503", "planner_sessions_batch_id_fkey", `DELETE FROM planner_batches WHERE id=$1`, [fx.whole.id]);
    await ok(c, `INSERT INTO planner_offering_faculty (offering_id, faculty_id) VALUES ($1,$2)`, [fx.offering.id, fx.f1.id]);
    await violates(c, "23503", "planner_offering_faculty_faculty_id_fkey", `DELETE FROM planner_faculty WHERE id=$1`, [fx.f1.id]);
    await ok(c, `INSERT INTO planner_session_faculty (session_id, faculty_id) VALUES ($1,$2)`, [s.id, fx.f2.id]);
    await violates(c, "23503", "planner_session_faculty_faculty_id_fkey", `DELETE FROM planner_faculty WHERE id=$1`, [fx.f2.id]);
    // once the session is gone the offering and batch can be deleted
    await c.query(`DELETE FROM planner_sessions WHERE id=$1`, [s.id]);
    await c.query(`DELETE FROM planner_offerings WHERE id=$1`, [fx.offering.id]);
    await c.query(`DELETE FROM planner_batches WHERE id=$1`, [fx.whole.id]);
  });
});

test("SET NULL / CASCADE for the soft references", async () => {
  await tx(async (c) => {
    const fx = await fixture(c);
    // home room: deleting the room nulls the division's home_room_id (no sessions reference it here)
    const r = await one(c, `SELECT id FROM rooms WHERE id <> ALL($1) AND NOT EXISTS (SELECT 1 FROM planner_sessions s WHERE s.room_id = rooms.id) LIMIT 1`, [[fx.room1, fx.room2]]);
    if (r) {
      await c.query(`UPDATE planner_divisions SET home_room_id=$1 WHERE id=$2`, [r.id, fx.division.id]);
      // room pool entry cascades with the room
      await c.query(`INSERT INTO planner_term_rooms (term_id, room_id, is_lab) VALUES ($1,$2,false)`, [fx.term.id, r.id]);
      await c.query(`DELETE FROM rooms WHERE id=$1`, [r.id]);
      const d = await one(c, `SELECT home_room_id FROM planner_divisions WHERE id=$1`, [fx.division.id]);
      assert.equal(d.home_room_id, null);
      const tr = await one(c, `SELECT count(*)::int AS n FROM planner_term_rooms WHERE term_id=$1`, [fx.term.id]);
      assert.equal(tr.n, 0);
    }
    // based_on_id SET NULL
    const v2 = await one(
      c,
      `INSERT INTO planner_versions (term_id, version_no, status, based_on_id) VALUES ($1,2,'published',$2) RETURNING *`,
      [fx.term.id, fx.version.id]
    );
    await c.query(`DELETE FROM planner_versions WHERE id=$1`, [fx.version.id]);
    const v = await one(c, `SELECT based_on_id FROM planner_versions WHERE id=$1`, [v2.id]);
    assert.equal(v.based_on_id, null);
  });
});

test("deleting a division cascades batches/offerings; deleting a subject cascades offerings; deleting an offering cascades its faculty links", async () => {
  await tx(async (c) => {
    const fx = await fixture(c);
    await c.query(`INSERT INTO planner_offering_faculty (offering_id, batch_id, faculty_id) VALUES ($1,$2,$3)`, [fx.offering.id, fx.batchA.id, fx.f1.id]);
    await c.query(`DELETE FROM planner_subjects WHERE id=$1`, [fx.subject.id]);
    assert.equal((await one(c, `SELECT count(*)::int AS n FROM planner_offerings WHERE id=$1`, [fx.offering.id])).n, 0);
    assert.equal((await one(c, `SELECT count(*)::int AS n FROM planner_offering_faculty WHERE offering_id=$1`, [fx.offering.id])).n, 0);
    await c.query(`DELETE FROM planner_divisions WHERE id=$1`, [fx.division.id]);
    assert.equal((await one(c, `SELECT count(*)::int AS n FROM planner_batches WHERE division_id=$1`, [fx.division.id])).n, 0);
  });
});

test("a PLACED session blocks deleting its division/offering/batch, yet deleting the whole term succeeds", async () => {
  await tx(async (c) => {
    const fx = await fixture(c);
    await ok(
      c,
      `INSERT INTO planner_sessions (version_id, offering_id, batch_id, seq, weekday, start_min, end_min, room_id)
       VALUES ($1,$2,$3,1,2,600,660,$4)`,
      [fx.version.id, fx.offering.id, fx.whole.id, fx.room1]
    );
    await violates(c, "23503", "planner_sessions_offering_id_fkey", `DELETE FROM planner_offerings WHERE id=$1`, [fx.offering.id]);
    await violates(c, "23503", null, `DELETE FROM planner_divisions WHERE id=$1`, [fx.division.id]);
    await violates(c, "23503", null, `DELETE FROM planner_subjects WHERE id=$1`, [fx.subject.id]);
    await violates(c, "23503", "planner_sessions_batch_id_fkey", `DELETE FROM planner_batches WHERE id=$1`, [fx.whole.id]);
    await violates(c, "23503", "planner_sessions_room_id_fkey", `DELETE FROM rooms WHERE id=$1`, [fx.room1]);
    // the whole term goes in one statement: cascades are checked at end of statement
    await c.query(`DELETE FROM planner_terms WHERE id=$1`, [fx.term.id]);
    const n = await one(c, `SELECT (SELECT count(*)::int FROM planner_sessions WHERE version_id=$1) AS s,
                                   (SELECT count(*)::int FROM planner_divisions WHERE id=$2) AS d`, [fx.version.id, fx.division.id]);
    assert.deepEqual(n, { s: 0, d: 0 });
  });
});

// ---------------------------------------------------------------------------
// Migration 016 on a throwaway database (never ALTERs the live planner_occupancy: test files run in parallel)
// ---------------------------------------------------------------------------
const PFX = "zz_planner_fresh_";

function adminConfig(database) {
  return {
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database,
  };
}

/** Applies one SQL text the way scripts/migrate.mjs does: a single transaction. */
async function applyFile(client, sql) {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

async function occupancyConstraints(client) {
  const { rows } = await client.query(
    `SELECT conname, oid, pg_get_constraintdef(oid) AS def, condeferrable, condeferred
       FROM pg_constraint WHERE conrelid = 'planner_occupancy'::regclass AND conname IN ('planner_occupancy_no_overlap', 'planner_occupancy_kind_check')`
  );
  return Object.fromEntries(rows.map((r) => [r.conname, r]));
}

test("016 on a throwaway database: fresh path (schema.sql + every migration + 016 again), 015-state upgrade with existing rows, idempotency", { timeout: 240000 }, async () => {
  assert.equal(process.env.DB_HOST, "localhost", "refusing to create databases anywhere but localhost");
  const name = `${PFX}${Math.random().toString(36).slice(2, 10)}`;
  assert.match(name, /^zz_planner_fresh_[a-z0-9]+$/);
  const migrationsDir = path.join(dbDir, "migrations");
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.includes("016_planner_lab_sharing.sql"));
  const m016 = await readFile(path.join(migrationsDir, "016_planner_lab_sharing.sql"), "utf8");

  await pool.query(`CREATE DATABASE ${name}`);
  let client;
  try {
    client = new pg.Client(adminConfig(name));
    await client.connect();

    // --- (a) fresh DB: schema.sql, then every migration in order (as dev-init.sh does), then 016 again
    await applyFile(client, await readFile(path.join(dbDir, "schema.sql"), "utf8"));
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    for (const f of files) {
      await applyFile(client, `${await readFile(path.join(migrationsDir, f), "utf8")}\n;INSERT INTO schema_migrations (filename) VALUES ('${f}');`);
    }
    const afterFresh = await occupancyConstraints(client);
    assertFinalOccupancyConstraints(afterFresh.planner_occupancy_kind_check, afterFresh.planner_occupancy_no_overlap);
    await applyFile(client, m016); // second application
    await applyFile(client, m016); // third, for good measure
    const afterAgain = await occupancyConstraints(client);
    assertFinalOccupancyConstraints(afterAgain.planner_occupancy_kind_check, afterAgain.planner_occupancy_no_overlap);
    for (const k of Object.keys(afterFresh)) assert.equal(afterAgain[k].oid, afterFresh[k].oid, `${k} untouched by a re-run (no drop/recreate)`);

    // --- (b) a database that is at migration 015 (old CHECK + unconditional exclusion) with rows already in it
    const { rows: [t] } = await client.query(`INSERT INTO planner_terms (academic_year, half) VALUES ('${PFX}t', 'odd') RETURNING id`);
    const { rows: [v] } = await client.query("INSERT INTO planner_versions (term_id, version_no) VALUES ($1, 1) RETURNING id", [t.id]);
    const { rows: [d] } = await client.query("INSERT INTO planner_divisions (term_id, semester, name) VALUES ($1, 1, 'A') RETURNING id", [t.id]);
    const { rows: [b] } = await client.query("INSERT INTO planner_batches (division_id, name, is_whole) VALUES ($1, 'ALL', true) RETURNING id", [d.id]);
    const { rows: [sub] } = await client.query("INSERT INTO planner_subjects (term_id, code, name, kind, duration_min) VALUES ($1, 'S', 'S', 'lab', 120) RETURNING id", [t.id]);
    const { rows: [o] } = await client.query("INSERT INTO planner_offerings (division_id, subject_id) VALUES ($1, $2) RETURNING id", [d.id, sub.id]);
    const sessionIds = [];
    for (let seq = 1; seq <= 4; seq++) {
      const { rows: [sx] } = await client.query("INSERT INTO planner_sessions (version_id, offering_id, batch_id, seq) VALUES ($1, $2, $3, $4) RETURNING id", [v.id, o.id, b.id, seq]);
      sessionIds.push(sx.id);
    }
    await client.query("ALTER TABLE planner_occupancy DROP CONSTRAINT planner_occupancy_kind_check");
    await client.query("ALTER TABLE planner_occupancy ADD CONSTRAINT planner_occupancy_kind_check CHECK (kind IN ('faculty', 'room', 'batch'))");
    await client.query("ALTER TABLE planner_occupancy DROP CONSTRAINT planner_occupancy_no_overlap");
    await client.query(`ALTER TABLE planner_occupancy ADD CONSTRAINT planner_occupancy_no_overlap
      EXCLUDE USING gist (version_id WITH =, kind WITH =, resource_id WITH =, weekday WITH =, during WITH &&) DEFERRABLE INITIALLY IMMEDIATE`);
    const res = "00000000-0000-4000-8000-0000000000aa";
    const ins = (sess, kind, lo, hi) => client.query(
      "INSERT INTO planner_occupancy (version_id, session_id, kind, resource_id, weekday, during) VALUES ($1, $2, $3, $4, 0, int4range($5, $6, '[)'))",
      [v.id, sess, kind, res, lo, hi]
    );
    await ins(sessionIds[0], "room", 540, 600);
    await ins(sessionIds[1], "faculty", 540, 600);
    const old = await occupancyConstraints(client);
    assert.doesNotMatch(old.planner_occupancy_kind_check.def, /lab_room/);
    assert.doesNotMatch(old.planner_occupancy_no_overlap.def, /lab_room/);
    await assert.rejects(ins(sessionIds[2], "lab_room", 540, 600), (e) => e.code === "23514", "015 state rejects lab_room");

    await applyFile(client, m016);
    const upgraded = await occupancyConstraints(client);
    assertFinalOccupancyConstraints(upgraded.planner_occupancy_kind_check, upgraded.planner_occupancy_no_overlap);
    const { rows: [kept] } = await client.query("SELECT count(*)::int AS n FROM planner_occupancy WHERE version_id = $1", [v.id]);
    assert.equal(kept.n, 2, "existing rows survive the constraint swap");
    await ins(sessionIds[2], "lab_room", 540, 660);
    await ins(sessionIds[3], "lab_room", 600, 720); // overlaps the previous shared row: allowed now
    await assert.rejects(ins(sessionIds[3], "room", 540, 600), (e) => e.code === "23P01" && e.constraint === "planner_occupancy_no_overlap", "exclusive kinds are still protected");

    const before = upgraded.planner_occupancy_no_overlap.oid;
    await applyFile(client, m016);
    const again = await occupancyConstraints(client);
    assert.equal(again.planner_occupancy_no_overlap.oid, before, "second application is a no-op");
    assertFinalOccupancyConstraints(again.planner_occupancy_kind_check, again.planner_occupancy_no_overlap);
  } finally {
    try { await client?.end(); } catch { /* ignore */ }
    assert.ok(name.startsWith(PFX));
    await pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
  const { rows: left } = await pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  assert.equal(left.length, 0, "throwaway database dropped");
});
