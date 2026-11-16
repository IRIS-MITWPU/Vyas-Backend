// Timetable generation runs (contract 9.1, 9.5, 9.6, 9.9): createRun / getRun / listRuns / cancelRun / undoRun / sweepStaleRuns.
//
// A run is a row in planner_generation_runs (migrations 017 + 018) plus a background task of THIS process: the engine runs in a
// worker_threads thread (generationRunner.js, at most 2 at a time process-wide), the plan is committed through
// editor.applyPlacements (the same checks as /ops, one transaction + one rev bump per ~100 placements), and the REST clients
// poll the row. Everything that leaves the process (planner:changed) is emitted ONCE per run, after the commit.
//
// Crash safety (9.9): after_placements / after_rev are written INSIDE each chunk's transaction (applyPlacements `finalize`),
// built from what applyPlacements really applied, so a run that dies at any point leaves an undoable record.
// Liveness: the executing process writes heartbeat_at (every progress write, every chunk and a 5 s timer); a queued/running
// row whose heartbeat is older than 2 minutes and that is not executing in this process is failed 'SERVER_RESTART' by
// sweepStaleRuns(), which runs lazily (create/list/get/undo) and every 60 s (app.js). A run executing in ANOTHER process is
// cancelled through cancel_requested, which the executor polls.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "./tx.js";
import { parse, uuid, int } from "./validate.js";
import {
  PlannerError, invalid, notDraft, generationRunning, notReady, notUndoable, runNotFound, runNotActive, confirmRequired,
} from "./errors.js";
import { getVersion, syncSessions } from "./sessions.js";
import { loadTermState } from "./state.js";
import { loadRules } from "./rules.js";
import { getSnapshot, applyPlacements } from "./editor.js";
import { computeReadiness } from "./domain/index.js";
import { buildSessionInfo, sessionKey } from "./engine/index.js";
import { startGeneration, acquireWorkerSlot, RunnerError } from "./generationRunner.js";

const PROGRESS_THROTTLE_MS = 500;
const CANCEL_WAIT_MS = 3000;
const HEARTBEAT_MS = 5000;
const STALE_AFTER_SECONDS = 120; // no heartbeat for 2 minutes (and not executing here) => SERVER_RESTART
const KEEP_RUNS = 20; // run retention per version
const LIST_LIMIT = 10;
const LIST_UNPLACED_CAP = 200;
const GET_UNPLACED_CAP = 1000;

/** Random id of this process: stored on the runs it executes (instance_id). */
const INSTANCE_ID = randomUUID();

/** Test seams (never set in production): chunk size of the commit and a hook awaited after every committed chunk. */
export const __test = { chunkSize: 100, afterChunk: null };

/** run id -> {cancelled, terminate, abortWait, io, done:Promise, resolve} for runs executing in THIS process. */
const active = new Map();
const undoing = new Set();

const bodySchema = z.object({
  mode: z.enum(["fill_unplaced", "regenerate_unlocked"], { error: "must be fill_unplaced or regenerate_unlocked" }).default("fill_unplaced"),
  division_ids: z.array(uuid).min(1, "choose at least one division").max(200, "at most 200 divisions").nullish(),
  seeds: int(1, 5).default(3),
  seed: int(0, 1000000).optional(),
  confirm: z.boolean({ error: "must be true or false" }).optional(),
});

const RUN_COLUMNS = `id, version_id, term_id, mode, scope, options, seed, status, stage, progress_percent, stats, unplaced,
  after_rev, undone_at, error_code, error_message, created_at, started_at, finished_at`;

/** Public run shape. `cap` limits the unplaced list (unplaced_total is always the full count). */
function toRun(row, cap) {
  const unplaced = Array.isArray(row.unplaced) ? row.unplaced : [];
  return {
    id: row.id,
    version_id: row.version_id,
    term_id: row.term_id,
    mode: row.mode,
    scope: row.scope,
    options: row.options,
    seed: row.seed,
    status: row.status,
    stage: row.stage,
    progress_percent: row.progress_percent,
    stats: row.stats,
    unplaced: unplaced.slice(0, cap),
    unplaced_total: unplaced.length,
    after_rev: row.after_rev === null || row.after_rev === undefined ? null : Number(row.after_rev),
    undone_at: row.undone_at,
    error_code: row.error_code,
    error_message: row.error_message,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

function emitChanged(io, versionId, prevRev, rev) {
  try {
    io?.to(`planner:version:${versionId}`).emit("planner:changed", { version_id: versionId, rev, prev_rev: prevRev, client_id: null, sessions: null, refetch: true });
  } catch (err) {
    console.error("planner:changed emit failed:", err?.message); // never fails the run
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function activeRunId(db, versionId) {
  const { rows } = await db.query("SELECT id FROM planner_generation_runs WHERE version_id = $1 AND status IN ('queued', 'running') LIMIT 1", [versionId]);
  return rows[0]?.id ?? null;
}

async function fetchRun(db, runId) {
  const { rows } = await db.query(`SELECT ${RUN_COLUMNS} FROM planner_generation_runs WHERE id = $1`, [runId]);
  return rows[0] ?? null;
}

// ------------------------------------------------------------------ queries

export async function getRun(runId) {
  if (!uuid.safeParse(runId).success) throw runNotFound();
  await sweepStaleRuns();
  const row = await fetchRun(pool, runId);
  if (!row) throw runNotFound();
  return toRun(row, GET_UNPLACED_CAP);
}

/** Newest first, max 10 (unplaced capped at 200 per run) plus the active run (or null). */
export async function listRuns(versionId) {
  await getVersion(pool, versionId); // 404 for an unknown version
  await sweepStaleRuns();
  const { rows } = await pool.query(
    `SELECT ${RUN_COLUMNS} FROM planner_generation_runs WHERE version_id = $1 ORDER BY created_at DESC, id LIMIT ${LIST_LIMIT}`,
    [versionId]
  );
  const runs = rows.map((r) => toRun(r, LIST_UNPLACED_CAP));
  let activeRun = runs.find((r) => r.status === "queued" || r.status === "running") ?? null;
  if (!activeRun) {
    const id = await activeRunId(pool, versionId);
    if (id) activeRun = toRun(await fetchRun(pool, id), LIST_UNPLACED_CAP);
  }
  return { runs, active: activeRun };
}

// ------------------------------------------------------------------ create

/**
 * Validates, syncs the sessions, checks readiness, inserts the run (status queued) and starts the background task.
 * Returns the queued run immediately (the caller answers 202).
 */
export async function createRun(versionId, body, { actorId = null, io = null } = {}) {
  const b = parse(bodySchema, body);
  const version = await getVersion(pool, versionId);
  if (b.mode === "regenerate_unlocked" && b.confirm !== true) throw confirmRequired();
  if (version.status !== "draft") throw notDraft();

  if (b.division_ids?.length) {
    const ids = [...new Set(b.division_ids)];
    b.division_ids = ids;
    const { rows } = await pool.query("SELECT id FROM planner_divisions WHERE term_id = $1 AND id = ANY($2::uuid[])", [version.term_id, ids]);
    if (rows.length !== ids.length) {
      const known = new Set(rows.map((r) => r.id));
      const fieldErrors = {};
      ids.forEach((id, i) => {
        if (!known.has(id)) fieldErrors[`division_ids.${i}`] = ["is not a division of this term"];
      });
      throw invalid("Some divisions do not belong to this term", fieldErrors);
    }
  }

  await sweepStaleRuns(); // a crashed run must not block a new one forever
  const runningId = await activeRunId(pool, versionId);
  if (runningId) throw generationRunning(runningId);

  const readiness = computeReadiness(await loadTermState(pool, version.term_id));
  if (readiness.counts.errors > 0) throw notReady(readiness.counts.errors);

  // the same function the sync-sessions route uses; one refetch event when it changed anything
  const sync = await syncSessions(versionId);
  if (sync.rev !== sync.prev_rev) emitChanged(io, versionId, sync.prev_rev, sync.rev);

  const seed = b.seed ?? 1;
  let row;
  try {
    const { rows } = await pool.query(
      `INSERT INTO planner_generation_runs (version_id, term_id, mode, scope, options, seed, status, stage, created_by, heartbeat_at, instance_id)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, 'queued', 'queued', $7, NOW(), $8)
       RETURNING ${RUN_COLUMNS}`,
      [
        versionId, version.term_id, b.mode,
        JSON.stringify({ division_ids: b.division_ids?.length ? b.division_ids : null }),
        JSON.stringify({ seeds: b.seeds, seed, confirm: b.confirm === true }),
        seed, actorId, INSTANCE_ID,
      ]
    );
    row = rows[0];
  } catch (err) {
    if (err?.code === "23505") throw generationRunning(await activeRunId(pool, versionId));
    throw err;
  }

  const state = { cancelled: false, terminate: null, abortWait: null, io, done: null, resolve: null };
  state.done = new Promise((r) => (state.resolve = r));
  active.set(row.id, state);
  setImmediate(() => {
    executeRun(row, b, state).catch((err) => console.error("Planner generation task crashed:", err));
  });
  return toRun(row, LIST_UNPLACED_CAP);
}

// ------------------------------------------------------------------ cancel

/**
 * Cancels a queued/running run (409 RUN_NOT_ACTIVE otherwise). A run of this process is stopped and the answer usually shows
 * `cancelled`. A run executing in ANOTHER process gets cancel_requested = true (its executor polls it) and the unchanged run
 * is returned. A run nobody executes any more (this process lost it, or no heartbeat for 2 minutes) is cancelled at once.
 */
export async function cancelRun(runId) {
  if (!uuid.safeParse(runId).success) throw runNotFound();
  const row = await fetchRun(pool, runId);
  if (!row) throw runNotFound();
  if (row.status !== "queued" && row.status !== "running") throw runNotActive();

  const state = active.get(runId);
  if (state) {
    state.cancelled = true;
    try {
      state.abortWait?.(); // still waiting for a free slot
      state.terminate?.();
    } catch {
      /* the thread may already be gone */
    }
    await Promise.race([state.done, sleep(CANCEL_WAIT_MS)]);
  } else {
    // not executing here: an orphan (lost state / dead process) is closed now, a live run of another process is asked to stop
    const { rowCount } = await pool.query(
      `UPDATE planner_generation_runs SET status = 'cancelled', stage = 'cancelled', finished_at = NOW()
        WHERE id = $1 AND status IN ('queued', 'running')
          AND (instance_id IS NOT DISTINCT FROM $2 OR COALESCE(heartbeat_at, started_at, created_at) < NOW() - make_interval(secs => $3))`,
      [runId, INSTANCE_ID, STALE_AFTER_SECONDS]
    );
    if (!rowCount) {
      await pool.query("UPDATE planner_generation_runs SET cancel_requested = TRUE WHERE id = $1 AND status IN ('queued', 'running')", [runId]);
    }
  }
  return toRun(await fetchRun(pool, runId), LIST_UNPLACED_CAP);
}

// ------------------------------------------------------------------ the background task

const slotOf = (s) => ({ session_id: s.id ?? s.session_id, weekday: s.weekday ?? null, start_min: s.start_min ?? null, room_id: s.room_id ?? null });
const sameSlot = (a, b) => a.weekday === b.weekday && a.start_min === b.start_min && a.room_id === b.room_id;
const bySession = (a, b) => (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0);

async function currentSlots(db, versionId, ids) {
  if (!ids.length) return [];
  const { rows } = await db.query(
    "SELECT id, weekday, start_min, room_id FROM planner_sessions WHERE version_id = $1 AND id = ANY($2::uuid[])",
    [versionId, ids]
  );
  return rows.map(slotOf).sort(bySession);
}

/** What the run changed, as undo needs it: the touched sessions whose last applied state differs from `before`. */
function effectiveAfter(afterMap, before) {
  const was = new Map(before.map((b) => [b.session_id, b]));
  return [...afterMap.values()].filter((a) => !was.has(a.session_id) || !sameSlot(a, was.get(a.session_id))).sort(bySession);
}

async function executeRun(run, params, state) {
  const runId = run.id;
  const versionId = run.version_id;
  const t0 = Date.now();
  const commit = { prevRev: null, rev: null }; // set by onChunk: chunks committed so far
  let outcome = { status: "failed", error_code: "GENERATION_FAILED", error_message: "The timetable generation failed.", stats: null, unplaced: null, afterRev: null };
  let before = [];
  const afterMap = new Map(); // session id -> {session_id, weekday, start_min, room_id}: last APPLIED state of every session the commit changed
  let releaseSlot = null;

  // liveness + cross-process cancel: every write below also reads cancel_requested
  const notePoll = (rows) => {
    if (rows?.[0]?.cancel_requested && !state.cancelled) {
      state.cancelled = true;
      try {
        state.abortWait?.();
        state.terminate?.();
      } catch {
        /* the thread may already be gone */
      }
    }
  };
  const beat = async (stage = null, pct = null) => {
    const { rows } = await pool.query(
      `UPDATE planner_generation_runs
          SET heartbeat_at = NOW(),
              stage = CASE WHEN status = 'running' AND $2::text IS NOT NULL THEN $2::text ELSE stage END,
              progress_percent = CASE WHEN status = 'running' AND $3::int IS NOT NULL THEN GREATEST(progress_percent, $3::int) ELSE progress_percent END
        WHERE id = $1 AND status IN ('queued', 'running')
        RETURNING cancel_requested`,
      [runId, stage, pct === null ? null : Math.max(0, Math.min(100, Math.round(pct)))]
    );
    notePoll(rows);
  };
  const timer = setInterval(() => beat().catch(() => {}), HEARTBEAT_MS);
  timer.unref?.();

  try {
    if (state.cancelled) throw new RunnerError("CANCELLED", "cancelled before start");
    releaseSlot = await acquireWorkerSlot(state); // stays 'queued' while 2 other generations use the threads
    if (state.cancelled) throw new RunnerError("CANCELLED", "cancelled before start");
    const started = await pool.query(
      `UPDATE planner_generation_runs SET status = 'running', stage = 'loading', progress_percent = 5, started_at = NOW(), heartbeat_at = NOW()
        WHERE id = $1 AND status = 'queued'`,
      [runId]
    );
    if (!started.rowCount) throw new RunnerError("CANCELLED", "run is no longer queued");

    const snapshot = await getSnapshot(versionId);
    const rules = (await loadRules(pool, run.term_id)).map(({ spec, ...row }) => row); // spec holds zod objects: not cloneable
    if (state.cancelled) throw new RunnerError("CANCELLED", "cancelled");

    // ---- engine in a worker thread; progress -> DB about every 500 ms
    let open = true;
    let lastWrite = 0;
    let inflight = Promise.resolve();
    let busy = false;
    const handle = startGeneration(
      { snapshot, rules, params: { mode: params.mode, divisionIds: params.division_ids ?? null, seeds: params.seeds, seed: params.seed ?? 1 } },
      {
        onProgress: (stage, pct) => {
          const now = Date.now();
          if (!open || busy || now - lastWrite < PROGRESS_THROTTLE_MS) return;
          lastWrite = now;
          busy = true;
          inflight = beat(stage, pct).catch(() => {}).finally(() => (busy = false));
        },
      }
    );
    state.terminate = handle.terminate;
    if (state.cancelled) handle.terminate();
    let result;
    try {
      result = await handle.promise;
    } finally {
      open = false;
      state.terminate = null;
      releaseSlot?.(); // the thread is done: the next queued run may start its own
      releaseSlot = null;
      await inflight;
    }
    if (state.cancelled) throw new RunnerError("CANCELLED", "cancelled");

    // ---- the plan is known: capture what it touches, then commit
    const unplaceList = result.unplace ?? result.unplace_ids.map((id) => id);
    const touched = [...new Set([...result.unplace_ids, ...result.units.flatMap((u) => u.placements.map((p) => p.session_id))])];
    before = await currentSlots(pool, versionId, touched);
    await pool.query(
      `UPDATE planner_generation_runs SET stage = 'committing', progress_percent = GREATEST(progress_percent, 85), before_placements = $2::jsonb, heartbeat_at = NOW()
        WHERE id = $1 AND status = 'running'`,
      [runId, JSON.stringify(before)]
    );

    commit.prevRev = Number((await getVersion(pool, versionId)).rev);
    commit.rev = commit.prevRev;
    const res = await applyPlacements(
      versionId,
      { unplace_ids: unplaceList, units: result.units },
      {
        chunk: __test.chunkSize,
        isCancelled: async () => {
          if (state.cancelled) return true;
          await beat().catch(() => {}); // heartbeat + cancel_requested poll at every chunk
          return state.cancelled;
        },
        // inside the chunk's transaction: the record of what was applied commits atomically with the chunk itself
        finalize: async (db, { rev, sessions }) => {
          for (const s of sessions) afterMap.set(s.id, slotOf(s));
          const { rows } = await db.query(
            `UPDATE planner_generation_runs
                SET after_placements = CASE WHEN $4 THEN $2::jsonb ELSE after_placements END,
                    after_rev = CASE WHEN $4 THEN $3 ELSE after_rev END,
                    heartbeat_at = NOW(), stage = 'committing'
              WHERE id = $1
              RETURNING cancel_requested`,
            [runId, JSON.stringify([...afterMap.values()].sort(bySession)), rev, afterMap.size > 0]
          );
          notePoll(rows);
        },
        onChunk: async ({ chunk_index, chunks, rev }) => {
          commit.rev = rev;
          await beat("committing", 85 + (13 * (chunk_index + 1)) / Math.max(1, chunks)).catch(() => {});
          if (__test.afterChunk) await __test.afterChunk({ chunk_index, chunks, run_id: runId });
        },
      }
    );
    commit.prevRev = res.prev_rev;
    commit.rev = res.rev;

    // ---- result: refused units become unplaced entries, stats from what was really applied
    const info = buildSessionInfo(snapshot).info;
    const entry = (sid, code, text) => {
      const i = info.get(sid);
      return { session_id: sid, key: sessionKey(i), division_id: i.division_id, subject_code: i.subject_code, batch_name: i.batch_name ?? null, kind: i.kind, code, text };
    };
    const unitById = new Map(result.units.map((u) => [u.unit_id, u]));
    const unplaced = [...result.unplaced];
    for (const r of res.refused_units) {
      const text = r.code === "STALE" ? "changed while the generation was running" : r.message;
      for (const p of unitById.get(r.unit_id)?.placements ?? []) unplaced.push(entry(p.session_id, "SERVER_REFUSED", text));
    }
    const byKind = {
      lab: { placed: 0, total: result.stats.by_kind?.lab?.total ?? 0 },
      theory: { placed: 0, total: result.stats.by_kind?.theory?.total ?? 0 },
    };
    let placed = 0;
    for (const id of res.applied_units) {
      for (const p of unitById.get(id)?.placements ?? []) {
        placed += 1;
        byKind[info.get(p.session_id)?.kind === "lab" ? "lab" : "theory"].placed += 1;
      }
    }
    outcome = {
      status: res.cancelled ? "cancelled" : "succeeded",
      error_code: null,
      error_message: null,
      stats: { ...result.stats, placed, unplaced: unplaced.length, duration_ms: Date.now() - t0, by_kind: byKind },
      unplaced,
      afterRev: res.rev,
    };
  } catch (err) {
    if (state.cancelled || err?.code === "CANCELLED" || err?.name === "GenerationCancelled") {
      outcome = { ...outcome, status: "cancelled", error_code: null, error_message: null };
    } else if (err instanceof RunnerError) {
      outcome = { ...outcome, status: "failed", error_code: err.code, error_message: err.message };
    } else if (err instanceof PlannerError) {
      outcome = { ...outcome, status: "failed", error_code: err.code, error_message: err.message };
    } else {
      console.error("Planner generation failed:", err);
      outcome = { ...outcome, status: "failed", error_code: "GENERATION_FAILED", error_message: "Something went wrong while generating the timetable." };
    }
  } finally {
    clearInterval(timer);
    releaseSlot?.();
    try {
      const moved = commit.rev !== null && commit.prevRev !== commit.rev; // a chunk really bumped rev
      const after = afterMap.size ? effectiveAfter(afterMap, before) : null; // what was APPLIED, never a fresh DB read
      let afterRev = outcome.afterRev;
      if (afterRev === null && moved) afterRev = commit.rev; // failed/cancelled after some chunks
      const done = outcome.status === "succeeded";
      await pool.query(
        `UPDATE planner_generation_runs
            SET status = $2, stage = $3, progress_percent = CASE WHEN $2 = 'succeeded' THEN 100 ELSE progress_percent END,
                stats = COALESCE($4::jsonb, stats), unplaced = COALESCE($5::jsonb, unplaced),
                after_placements = COALESCE($6::jsonb, after_placements), after_rev = COALESCE($7, after_rev),
                error_code = $8, error_message = $9, finished_at = NOW(), heartbeat_at = NOW()
          WHERE id = $1 AND status IN ('queued', 'running')`,
        [
          runId, outcome.status, done ? "done" : outcome.status === "cancelled" ? "cancelled" : "failed",
          outcome.stats ? JSON.stringify(outcome.stats) : null,
          outcome.unplaced ? JSON.stringify(outcome.unplaced) : null,
          after ? JSON.stringify(after) : null,
          afterRev, outcome.error_code, outcome.error_message,
        ]
      );
      if (moved) emitChanged(state.io, versionId, commit.prevRev, commit.rev);
    } catch (err) {
      console.error("Planner generation: could not store the final state:", err?.message);
      await pool
        .query(
          `UPDATE planner_generation_runs SET status = 'failed', stage = 'failed', error_code = 'GENERATION_FAILED', error_message = 'The result could not be stored.', finished_at = NOW()
            WHERE id = $1 AND status IN ('queued', 'running')`,
          [runId]
        )
        .catch(() => {});
    } finally {
      active.delete(runId);
      state.resolve?.();
    }
    await pruneRuns(versionId).catch(() => {});
  }
}

// ------------------------------------------------------------------ retention

/** Keeps the newest `keep` runs of the version; older finished runs are deleted (an active run is never deleted). */
export async function pruneRuns(versionId, keep = KEEP_RUNS) {
  const { rowCount } = await pool.query(
    `DELETE FROM planner_generation_runs
      WHERE version_id = $1 AND status NOT IN ('queued', 'running')
        AND id NOT IN (SELECT id FROM planner_generation_runs WHERE version_id = $1 ORDER BY created_at DESC, id LIMIT $2)`,
    [versionId, keep]
  );
  return rowCount;
}

// ------------------------------------------------------------------ undo

/**
 * Undo of the most recent non-undone run of the version that changed something (9.1.9, 9.9). ONE transaction (applyPlacements
 * atomic): everything restorable (still exactly where the run left it, unlocked) is unplaced first and then re-placed where it
 * was, one unit per session; a refused restore falls back, in the same transaction, to re-placing that session at the slot the
 * run gave it, so an undo never leaves a session unplaced because one restore was refused. Sessions the admin changed since
 * are skipped. The "no run is active" check and the apply happen under the same version-row lock.
 * Returns {run, restored, skipped_session_ids, refused:[{session_id, code, message, fallback_applied}], rev}.
 */
export async function undoRun(runId, { io = null } = {}) {
  if (!uuid.safeParse(runId).success) throw runNotFound();
  await sweepStaleRuns();
  const row = await pool
    .query("SELECT id, version_id, status, undone_at, after_rev, before_placements, after_placements FROM planner_generation_runs WHERE id = $1", [runId])
    .then((r) => r.rows[0]);
  if (!row) throw runNotFound();
  if (undoing.has(runId)) throw notUndoable("This generation is already being undone");

  const version = await getVersion(pool, row.version_id);
  if (row.undone_at) throw notUndoable("This generation was already undone");
  if (row.status === "queued" || row.status === "running") throw notUndoable("This generation is still running");
  if (version.status !== "draft") throw notUndoable("Only a draft version can be changed");
  if (await activeRunId(pool, row.version_id)) throw notUndoable("Another generation is running for this version");
  const afterList = Array.isArray(row.after_placements) ? row.after_placements : [];
  if (row.after_rev === null || !afterList.length) throw notUndoable("This generation did not change anything");
  const { rows: [latest] } = await pool.query(
    `SELECT id FROM planner_generation_runs
      WHERE version_id = $1 AND undone_at IS NULL AND after_rev IS NOT NULL AND jsonb_array_length(after_placements) > 0
      ORDER BY created_at DESC, id LIMIT 1`,
    [row.version_id]
  );
  if (latest?.id !== runId) throw notUndoable("Only the most recent generation can be undone");

  undoing.add(runId);
  try {
    const snapshot = await getSnapshot(row.version_id); // fresh: "current placement" is compared against this
    const current = new Map(snapshot.sessions.map((s) => [s.id, { ...slotOf(s), locked: !!s.locked }]));
    const beforeBy = new Map((row.before_placements ?? []).map((b) => [b.session_id, b]));
    const expectOf = (p) => ({ weekday: p.weekday, start_min: p.start_min, room_id: p.room_id ?? null });

    const skipped = [];
    const unplaceIds = [];
    const units = [];
    const unitSession = new Map(); // unit id -> session id
    const restorable = []; // session ids the undo tries to bring back
    for (const a of afterList) {
      const cur = current.get(a.session_id);
      const was = beforeBy.get(a.session_id) ?? { session_id: a.session_id, weekday: null, start_min: null, room_id: null };
      const wasPlaced = was.weekday !== null && was.start_min !== null;
      // admin changed it since, deleted it, locked it, or the old placement cannot be replayed without a room
      if (!cur || cur.locked || !sameSlot(cur, a) || (wasPlaced && !was.room_id)) {
        skipped.push(a.session_id);
        continue;
      }
      restorable.push(a.session_id);
      const afterPlaced = a.weekday !== null;
      if (afterPlaced) unplaceIds.push({ session_id: a.session_id, expect: expectOf(a) });
      if (wasPlaced) {
        const unitId = `u${units.length + 1}`;
        unitSession.set(unitId, a.session_id);
        units.push({
          unit_id: unitId,
          placements: [{ session_id: a.session_id, weekday: was.weekday, start_min: was.start_min, room_id: was.room_id, expect: null }],
          ...(afterPlaced ? { fallback: [{ session_id: a.session_id, weekday: a.weekday, start_min: a.start_min, room_id: a.room_id, expect: null }] } : {}),
        });
      }
    }

    const res = await applyPlacements(
      row.version_id,
      { unplace_ids: unplaceIds, units },
      {
        atomic: true,
        guard: async (db, ver) => {
          // same version-row lock as the apply: no run can be active, and nobody else undid this run
          if (await activeRunId(db, ver.id)) throw notUndoable("Another generation is running for this version");
          const { rows: [r] } = await db.query("SELECT undone_at FROM planner_generation_runs WHERE id = $1 FOR UPDATE", [runId]);
          if (!r) throw runNotFound();
          if (r.undone_at) throw notUndoable("This generation was already undone");
        },
        finalize: async (db) => {
          await db.query("UPDATE planner_generation_runs SET undone_at = NOW() WHERE id = $1", [runId]);
        },
      }
    );

    const notRestored = new Set([...res.skipped_locked, ...res.skipped_stale]);
    const refused = [];
    for (const r of res.refused_units) {
      const sid = unitSession.get(r.unit_id);
      notRestored.add(sid);
      if (!res.skipped_stale.includes(sid) && !res.skipped_locked.includes(sid)) {
        refused.push({ session_id: sid, code: r.code, message: r.message, fallback_applied: r.fallback_applied ?? false });
      }
    }
    const restored = restorable.filter((id) => !notRestored.has(id)).length;
    if (res.rev !== res.prev_rev) emitChanged(io, row.version_id, res.prev_rev, res.rev);
    return {
      run: toRun(await fetchRun(pool, runId), LIST_UNPLACED_CAP),
      restored,
      skipped_session_ids: [...skipped, ...[...notRestored].filter((id) => restorable.includes(id))],
      refused,
      rev: res.rev,
    };
  } finally {
    undoing.delete(runId);
  }
}

// ------------------------------------------------------------------ stale sweep

/**
 * Fails queued/running runs that nobody is executing: not in this process's active map and no heartbeat for 2 minutes
 * (heartbeat_at, falling back to started_at / created_at) -> status failed, stage failed, error_code 'SERVER_RESTART'. The
 * persisted after_placements stay, so such a run is still undoable. Called lazily (create/list/get/undo) and every 60 s from
 * app.js. Never throws: a missing table (the dev server reloads on every save, migration 017/018 may not be applied) is fine.
 */
export async function sweepStaleRuns() {
  try {
    const { rows: [t] } = await pool.query("SELECT to_regclass('public.planner_generation_runs') AS t");
    if (!t?.t) return 0;
    const mine = [...active.keys()];
    const { rowCount } = await pool.query(
      `UPDATE planner_generation_runs
          SET status = 'failed', stage = 'failed', error_code = 'SERVER_RESTART',
              error_message = 'The server restarted while this generation was running.', finished_at = NOW()
        WHERE status IN ('queued', 'running') AND COALESCE(heartbeat_at, started_at, created_at) < NOW() - make_interval(secs => $1)
          AND NOT (id = ANY($2::uuid[]))`,
      [STALE_AFTER_SECONDS, mine]
    );
    if (rowCount) console.log(`[Planner] marked ${rowCount} stale generation run(s) as failed`);
    return rowCount;
  } catch (err) {
    console.error("[Planner] stale generation sweep failed:", err?.message);
    return 0;
  }
}
