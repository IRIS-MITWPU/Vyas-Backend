// Generation runs (contract 9.6 / 9.1): POST /versions/:id/generate, GET /versions/:id/generation, GET /generation-runs/:id,
// cancel, undo and the stale-run sweep. Needs a server at BASE_URL started with RUN_WORKERS=false PLANNER_ENABLED=true.
//
// World (see _editorUtil.js): division X (3 batches) and Y, 9 sessions in all; the whole timetable fits easily, so a
// generation always places everything. Every test starts from a clean slate (resetWorld + no run rows).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { io as ioClient } from "socket.io-client";
import { pool, openSessions, newUid, scope, cleanup, BASE_URL, makeTerm, fieldErrorsOf } from "./_util.js";
import { WED, buildWorld, refreshSessions, S, ops, place, resetWorld, revOf, occupancyIsConsistent } from "./_editorUtil.js";
import { sweepStaleRuns, createRun, cancelRun, pruneRuns, __test } from "../../../services/planner/generation.js";
import { acquireWorkerSlot, setMaxWorkers, workerSlots } from "../../../services/planner/generationRunner.js";

const THU = 3;
const FRI = 4;
const s = scope(newUid());
let sessions;
let api;
let w;
const sockets = [];
const NOPE = "00000000-0000-4000-8000-000000000000";

before(async () => {
  sessions = await openSessions();
  api = sessions.api;
  w = await buildWorld(api, s);
});
after(async () => {
  for (const sock of sockets) sock.close();
  await cleanup(s, sessions);
});
beforeEach(async () => {
  await settle(w.versionId);
  await pool.query("DELETE FROM planner_generation_runs WHERE version_id = $1", [w.versionId]);
  await resetWorld(w);
  await refreshSessions(w);
});

// ------------------------------------------------------------------ helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits until no run of the version is queued/running (also after a failed test). */
async function settle(versionId) {
  for (let i = 0; i < 200; i++) {
    const { rows } = await pool.query("SELECT 1 FROM planner_generation_runs WHERE version_id = $1 AND status IN ('queued','running') LIMIT 1", [versionId]);
    if (!rows.length) return;
    await sleep(100);
  }
}

const generate = (body = {}, versionId = w.versionId) => api("POST", `/versions/${versionId}/generate`, body);

async function waitRun(runId) {
  for (let i = 0; i < 300; i++) {
    const r = await api("GET", `/generation-runs/${runId}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (r.body.run.status !== "queued" && r.body.run.status !== "running") return r.body.run;
    await sleep(100);
  }
  throw new Error("generation did not finish in 30 s");
}

/** POST generate (expects 202) and waits for the end of the run. */
async function run(body = {}) {
  const g = await generate(body);
  assert.equal(g.status, 202, JSON.stringify(g.body));
  return waitRun(g.body.run.id);
}

/** Every session of the version: id -> {weekday,start_min,end_min,room_id,locked}. */
async function placements() {
  const { rows } = await pool.query("SELECT id, weekday, start_min, end_min, room_id, locked FROM planner_sessions WHERE version_id = $1", [w.versionId]);
  return new Map(rows.map((r) => [r.id, r]));
}
const slot = (p) => `${p.weekday}|${p.start_min}|${p.room_id}`;
const placedCount = (m) => [...m.values()].filter((p) => p.weekday !== null).length;

/** Independent clash check straight from the sessions table (no engine, no occupancy table). */
async function clashes() {
  const base = `
    SELECT a.id AS a, b.id AS b
      FROM planner_sessions a JOIN planner_sessions b
        ON a.version_id = b.version_id AND a.id < b.id AND a.weekday = b.weekday
       AND a.start_min < b.end_min AND b.start_min < a.end_min
      JOIN planner_offerings oa ON oa.id = a.offering_id JOIN planner_offerings ob ON ob.id = b.offering_id
      JOIN planner_subjects sa ON sa.id = oa.subject_id JOIN planner_subjects sb ON sb.id = ob.subject_id
      JOIN planner_batches ba ON ba.id = a.batch_id JOIN planner_batches bb ON bb.id = b.batch_id
     WHERE a.version_id = $1 AND a.weekday IS NOT NULL AND b.weekday IS NOT NULL`;
  const faculty = await pool.query(
    `${base} AND EXISTS (SELECT 1 FROM planner_session_faculty fa JOIN planner_session_faculty fb ON fb.faculty_id = fa.faculty_id
                          WHERE fa.session_id = a.id AND fb.session_id = b.id)`, [w.versionId]);
  const division = await pool.query(
    `${base} AND oa.division_id = ob.division_id AND (ba.is_whole OR bb.is_whole OR a.batch_id = b.batch_id)`, [w.versionId]);
  // rooms are exclusive unless BOTH are lab sessions (labs share a lab room by capacity: 3 x 8 students fit)
  const room = await pool.query(`${base} AND a.room_id = b.room_id AND NOT (sa.kind = 'lab' AND sb.kind = 'lab')`, [w.versionId]);
  const bad = await pool.query(
    `SELECT id FROM planner_sessions WHERE version_id = $1 AND weekday IS NOT NULL
        AND (room_id IS NULL OR weekday > 4 OR start_min < 510 OR end_min > 1065
             OR (start_min < 645 AND end_min > 630) OR (start_min < 810 AND end_min > 765) OR (start_min < 945 AND end_min > 930)
             OR start_min % 15 <> 0)`, [w.versionId]);
  return { faculty: faculty.rowCount, division: division.rowCount, room: room.rowCount, invalid: bad.rowCount };
}
const assertNoClashes = async () => assert.deepEqual(await clashes(), { faculty: 0, division: 0, room: 0, invalid: 0 });

const connect = (cookie) =>
  new Promise((resolve, reject) => {
    const sock = ioClient(BASE_URL, { extraHeaders: { Cookie: cookie }, transports: ["websocket"], reconnection: false });
    sockets.push(sock);
    sock.once("connect", () => resolve(sock));
    sock.once("connect_error", reject);
  });

/** Odd, deterministic pre-placements the generator will want to move: returns the ids placed. */
async function placeOdd() {
  const [C0, C1] = w.rooms.classrooms;
  const list = [
    place(w, S(w, "X", "TH1", "ALL", 1), THU, 960, C0),
    place(w, S(w, "X", "TH1", "ALL", 2), FRI, 960, C0),
    place(w, S(w, "X", "TH2"), WED, 960, C0),
    place(w, S(w, "Y", "TH1", "ALL", 1), WED, 960, C1),
  ];
  const r = await ops(w, list);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return list.map((o) => o.session_id);
}

// ------------------------------------------------------------------ validation and guards

test("body validation: bad mode / seeds / ids are 400 with fieldErrors; confirm is required for regenerate_unlocked (422)", async () => {
  let res = await generate({ mode: "everything" });
  assert.equal(res.status, 400);
  assert.ok(fieldErrorsOf(res).mode);
  for (const seeds of [0, 6, 1.5, "3"]) {
    res = await generate({ seeds });
    assert.equal(res.status, 400, `seeds=${seeds}`);
    assert.ok(fieldErrorsOf(res).seeds);
  }
  res = await generate({ division_ids: ["nope"] });
  assert.equal(res.status, 400);
  assert.ok(Object.keys(fieldErrorsOf(res)).some((k) => k.startsWith("division_ids")));
  res = await generate({ seed: -1 });
  assert.equal(res.status, 400);

  for (const body of [{ mode: "regenerate_unlocked" }, { mode: "regenerate_unlocked", confirm: false }]) {
    res = await generate(body);
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.equal(res.body.code, "CONFIRM_REQUIRED");
  }
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM planner_generation_runs WHERE version_id = $1", [w.versionId])).rows[0].n, 0);
  assert.equal((await sessions.userApi("POST", `/versions/${w.versionId}/generate`, {})).status, 403);
  assert.equal((await generate({}, NOPE)).status, 404);
});

test("division_ids must belong to the version's term", async () => {
  const other = await makeTerm(api, s);
  const od = await api("POST", `/terms/${other.id}/divisions`, { semester: 3, name: "Z", student_count: 20 });
  assert.equal(od.status, 201, JSON.stringify(od.body));
  const res = await generate({ division_ids: [w.X.id, od.body.division.id] });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "VALIDATION_ERROR");
  assert.ok(fieldErrorsOf(res)["division_ids.1"]);
});

test("NOT_READY: a term whose setup has errors cannot generate (422, details.errors counts them)", async () => {
  const t = await makeTerm(api, s);
  const rd = await api("GET", `/terms/${t.id}/readiness`);
  assert.ok(rd.body.counts.errors > 0, "an empty term has readiness errors");
  const res = await generate({}, t.versionId);
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.equal(res.body.code, "NOT_READY");
  assert.equal(res.body.details.errors, rd.body.counts.errors);
});

test("NOT_DRAFT: a published version cannot be generated", async () => {
  await pool.query("UPDATE planner_versions SET status = 'published' WHERE id = $1", [w.versionId]);
  const res = await generate({});
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "NOT_DRAFT");
});

test("GENERATION_RUNNING: an active run row blocks a second run (409 with the active run id), then frees up", async () => {
  const { rows: [ins] } = await pool.query(
    "INSERT INTO planner_generation_runs (version_id, term_id, mode, status) VALUES ($1, $2, 'fill_unplaced', 'running') RETURNING id",
    [w.versionId, w.termId]
  );
  const res = await generate({});
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "GENERATION_RUNNING");
  assert.equal(res.body.details.run_id, ins.id);
  const list = await api("GET", `/versions/${w.versionId}/generation`);
  assert.equal(list.body.active.id, ins.id);
  await pool.query("UPDATE planner_generation_runs SET status = 'failed' WHERE id = $1", [ins.id]);
  const ok = await run({});
  assert.equal(ok.status, "succeeded");
});

test("GENERATION_RUNNING: two simultaneous requests start exactly one run", async () => {
  const [a, b] = await Promise.all([generate({ seeds: 5 }), generate({ seeds: 5 })]);
  const codes = [a.status, b.status].sort();
  assert.deepEqual(codes, [202, 409], JSON.stringify([a.body, b.body]));
  const win = a.status === 202 ? a : b;
  const lose = a.status === 202 ? b : a;
  assert.equal(lose.body.code, "GENERATION_RUNNING");
  assert.equal(lose.body.details.run_id, win.body.run.id);
  assert.equal((await waitRun(win.body.run.id)).status, "succeeded");
});

// ------------------------------------------------------------------ fill mode

test("fill_unplaced on a small world: 202 queued run, polls to success, places everything, stats and listing shape", async () => {
  const rev0 = await revOf(w.versionId);
  const g = await generate({});
  assert.equal(g.status, 202);
  const r0 = g.body.run;
  assert.equal(g.body.success, true);
  assert.equal(r0.status, "queued");
  assert.equal(r0.mode, "fill_unplaced");
  assert.deepEqual(r0.scope, { division_ids: null });
  assert.equal(r0.options.seeds, 3);
  assert.equal(r0.version_id, w.versionId);
  assert.equal(r0.term_id, w.termId);
  assert.equal(r0.undone_at, null);
  assert.equal("before_placements" in r0 || "after_placements" in r0, false);

  const done = await waitRun(r0.id);
  assert.equal(done.status, "succeeded", JSON.stringify(done));
  assert.equal(done.stage, "done");
  assert.equal(done.progress_percent, 100);
  assert.equal(done.error_code, null);
  assert.ok(done.started_at && done.finished_at);
  assert.equal(done.stats.requested, 9);
  assert.equal(done.stats.placed, 9);
  assert.equal(done.stats.unplaced, 0);
  assert.deepEqual(done.stats.by_kind, { lab: { placed: 3, total: 3 }, theory: { placed: 6, total: 6 } });
  for (const k of ["seeds_tried", "best_seed", "score", "repair_moves", "duration_ms"]) assert.equal(typeof done.stats[k], "number", k);
  assert.equal(done.stats.seeds_tried, 3);
  assert.deepEqual(done.unplaced, []);
  assert.equal(done.unplaced_total, 0);
  assert.equal(typeof done.after_rev, "number");
  assert.equal(done.after_rev, await revOf(w.versionId));
  assert.ok(done.after_rev > rev0);
  assert.equal("before_placements" in done || "after_placements" in done, false);

  const all = await placements();
  assert.equal(placedCount(all), 9);
  await assertNoClashes();
  assert.equal(await occupancyIsConsistent(w.versionId), true);
  // labs sit in lab rooms
  for (const b of ["X1", "X2", "X3"]) assert.ok(w.rooms.labs.includes(all.get(S(w, "X", "LB", b)).room_id));

  const list = await api("GET", `/versions/${w.versionId}/generation`);
  assert.equal(list.status, 200);
  assert.equal(list.body.active, null);
  assert.equal(list.body.runs.length, 1);
  assert.equal(list.body.runs[0].id, r0.id);
  assert.equal(list.body.runs[0].unplaced_total, 0);

  assert.equal((await api("GET", `/generation-runs/${NOPE}`)).body.code, "RUN_NOT_FOUND");
  assert.equal((await api("GET", "/generation-runs/not-a-uuid")).status, 404);
  assert.equal((await api("GET", `/versions/${NOPE}/generation`)).status, 404);
});

test("fill_unplaced never moves a session that is already placed (locked or not)", async () => {
  const [C0] = w.rooms.classrooms;
  const a = S(w, "X", "TH1", "ALL", 1);
  const b = S(w, "Y", "TH2");
  const r = await ops(w, [place(w, a, FRI, 960, C0), place(w, b, THU, 1005, w.rooms.classrooms[1]), { op: "lock", session_id: b }]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const before = await placements();
  const done = await run({});
  assert.equal(done.status, "succeeded", JSON.stringify(done));
  assert.equal(done.stats.requested, 7);
  assert.equal(done.stats.placed, 7);
  const after = await placements();
  assert.equal(slot(after.get(a)), slot(before.get(a)));
  assert.equal(slot(after.get(b)), slot(before.get(b)));
  assert.equal(after.get(b).locked, true);
  assert.equal(placedCount(after), 9);
  await assertNoClashes();
});

test("division_ids restricts the scope: the other division stays unplaced", async () => {
  const done = await run({ division_ids: [w.X.id] });
  assert.equal(done.status, "succeeded", JSON.stringify(done));
  assert.deepEqual(done.scope, { division_ids: [w.X.id] });
  assert.equal(done.stats.requested, 6);
  const all = await placements();
  for (const [code, b] of [["TH1", "ALL"], ["TH2", "ALL"]]) assert.equal(all.get(S(w, "Y", code, b, 1)).weekday, null);
  assert.equal(all.get(S(w, "X", "TH1", "ALL", 1)).weekday !== null, true);
  await assertNoClashes();
});

test("one planner:changed {refetch:true} per run, after the commit", async () => {
  const sock = await connect(sessions.admin.cookie);
  const ack = await new Promise((res) => sock.emit("join:planner", { version_id: w.versionId }, res));
  assert.deepEqual(ack, { ok: true });
  const events = [];
  sock.on("planner:changed", (p) => events.push(p));
  const rev0 = await revOf(w.versionId);
  const done = await run({});
  await sleep(500);
  assert.equal(done.status, "succeeded");
  assert.equal(events.length, 1, JSON.stringify(events));
  assert.deepEqual(events[0], { version_id: w.versionId, rev: done.after_rev, prev_rev: rev0, client_id: null, sessions: null, refetch: true });
  sock.off("planner:changed");
});

// ------------------------------------------------------------------ regenerate

test("regenerate_unlocked re-plans every unlocked session but never moves a locked one", async () => {
  const odd = await placeOdd();
  const lockedId = S(w, "X", "TH2");
  assert.ok(odd.includes(lockedId));
  const lk = await ops(w, [{ op: "lock", session_id: lockedId }]);
  assert.equal(lk.status, 200, JSON.stringify(lk.body));
  const before = await placements();
  const done = await run({ mode: "regenerate_unlocked", confirm: true });
  assert.equal(done.status, "succeeded", JSON.stringify(done));
  assert.equal(done.mode, "regenerate_unlocked");
  assert.equal(done.stats.requested, 8); // 9 sessions minus the locked one
  assert.equal(done.stats.placed, 8);
  const after = await placements();
  assert.equal(slot(after.get(lockedId)), slot(before.get(lockedId)));
  assert.equal(after.get(lockedId).locked, true);
  assert.equal(placedCount(after), 9);
  // the unlocked pre-placements moved to better slots
  assert.ok([S(w, "X", "TH1", "ALL", 1), S(w, "X", "TH1", "ALL", 2), S(w, "Y", "TH1", "ALL", 1)].some((id) => slot(after.get(id)) !== slot(before.get(id))));
  await assertNoClashes();
  assert.equal(await occupancyIsConsistent(w.versionId), true);
});

// ------------------------------------------------------------------ undo

test("undo of a regenerate run restores the exact previous placement of every touched session", async () => {
  await placeOdd();
  const before = await placements();
  const done = await run({ mode: "regenerate_unlocked", confirm: true });
  assert.equal(done.status, "succeeded", JSON.stringify(done));
  const mid = await placements();
  assert.notDeepEqual([...mid.values()].map(slot).sort(), [...before.values()].map(slot).sort());

  const rev1 = await revOf(w.versionId);
  const u = await api("POST", `/generation-runs/${done.id}/undo`);
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(u.body.success, true);
  assert.deepEqual(u.body.skipped_session_ids, []);
  assert.equal(u.body.restored, 9); // 4 re-placed where they were + 5 unplaced again
  assert.ok(u.body.run.undone_at);
  assert.equal(u.body.run.id, done.id);
  assert.ok((await revOf(w.versionId)) > rev1);

  const after = await placements();
  for (const [id, p] of before) {
    assert.equal(after.get(id).weekday, p.weekday, id);
    assert.equal(after.get(id).start_min, p.start_min, id);
    assert.equal(after.get(id).end_min, p.end_min, id);
    assert.equal(after.get(id).room_id, p.room_id, id);
  }
  assert.equal(placedCount(after), 4);
  assert.equal(await occupancyIsConsistent(w.versionId), true);
  await assertNoClashes();

  const again = await api("POST", `/generation-runs/${done.id}/undo`);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "NOT_UNDOABLE");
  const list = await api("GET", `/versions/${w.versionId}/generation`);
  assert.ok(list.body.runs[0].undone_at);
});

test("undo skips a session the admin changed after the run and reports it", async () => {
  await placeOdd();
  const before = await placements();
  const done = await run({ mode: "regenerate_unlocked", confirm: true });
  assert.equal(done.status, "succeeded", JSON.stringify(done));
  const mid = await placements();
  const moved = S(w, "X", "TH1", "ALL", 1);
  assert.notEqual(slot(mid.get(moved)), slot(before.get(moved)));
  const edited = await ops(w, [{ op: "unplace", session_id: moved }]);
  assert.equal(edited.status, 200, JSON.stringify(edited.body));

  const u = await api("POST", `/generation-runs/${done.id}/undo`);
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.deepEqual(u.body.skipped_session_ids, [moved]);
  assert.equal(u.body.restored, 8);
  const after = await placements();
  assert.equal(after.get(moved).weekday, null, "the admin's edit stays");
  for (const [id, p] of before) {
    if (id === moved) continue;
    assert.equal(slot(after.get(id)), slot(p), id);
  }
  assert.equal(await occupancyIsConsistent(w.versionId), true);
});

test("undo skips a session that was locked after the run (it cannot be unplaced) and reports it", async () => {
  const odd = await placeOdd();
  const before = await placements();
  const done = await run({ mode: "regenerate_unlocked", confirm: true });
  assert.equal(done.status, "succeeded", JSON.stringify(done));
  const mid = await placements();
  const lockedId = odd.find((id) => slot(mid.get(id)) !== slot(before.get(id)));
  assert.ok(lockedId, "one pre-placed session moved");
  assert.equal((await ops(w, [{ op: "lock", session_id: lockedId }])).status, 200);
  const u = await api("POST", `/generation-runs/${done.id}/undo`);
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.deepEqual(u.body.skipped_session_ids, [lockedId]);
  assert.equal(slot((await placements()).get(lockedId)), slot(mid.get(lockedId)));
  assert.equal(await occupancyIsConsistent(w.versionId), true);
});

test("NOT_UNDOABLE: not the latest run, run without changes, failed run, active run, published version, unknown run", async () => {
  await placeOdd();
  const first = await run({ mode: "regenerate_unlocked", confirm: true });
  assert.equal(first.status, "succeeded");
  const second = await run({ mode: "regenerate_unlocked", confirm: true, seed: 11 });
  assert.equal(second.status, "succeeded");
  // the FIRST run is not the latest one that changed something (when the second changed nothing the first still is)
  const secondChanged = (await pool.query("SELECT jsonb_array_length(after_placements) > 0 AS c FROM planner_generation_runs WHERE id = $1", [second.id])).rows[0].c;
  let res = { status: 409, body: { code: "NOT_UNDOABLE" } };
  if (secondChanged) {
    res = await api("POST", `/generation-runs/${first.id}/undo`);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, "NOT_UNDOABLE");
  }

  // a run that changed nothing (everything already placed)
  const noop = await run({});
  assert.equal(noop.status, "succeeded");
  assert.equal(noop.stats.requested, 0);
  res = await api("POST", `/generation-runs/${noop.id}/undo`);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "NOT_UNDOABLE");

  // a failed run
  const { rows: [f] } = await pool.query(
    "INSERT INTO planner_generation_runs (version_id, term_id, mode, status, error_code) VALUES ($1, $2, 'fill_unplaced', 'failed', 'GENERATION_FAILED') RETURNING id",
    [w.versionId, w.termId]
  );
  res = await api("POST", `/generation-runs/${f.id}/undo`);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "NOT_UNDOABLE");

  // an active run blocks undo of the (otherwise undoable) latest changed run
  const { rows: [act] } = await pool.query(
    "INSERT INTO planner_generation_runs (version_id, term_id, mode, status) VALUES ($1, $2, 'fill_unplaced', 'running') RETURNING id",
    [w.versionId, w.termId]
  );
  const latest = (await pool.query(
    "SELECT id FROM planner_generation_runs WHERE version_id = $1 AND jsonb_array_length(after_placements) > 0 ORDER BY created_at DESC LIMIT 1", [w.versionId]
  )).rows[0];
  if (latest) {
    res = await api("POST", `/generation-runs/${latest.id}/undo`);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, "NOT_UNDOABLE");
  }
  await pool.query("UPDATE planner_generation_runs SET status = 'failed' WHERE id = $1", [act.id]);

  // a published version
  if (latest) {
    await pool.query("UPDATE planner_versions SET status = 'published' WHERE id = $1", [w.versionId]);
    res = await api("POST", `/generation-runs/${latest.id}/undo`);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "NOT_UNDOABLE");
  }

  assert.equal((await api("POST", `/generation-runs/${NOPE}/undo`)).body.code, "RUN_NOT_FOUND");
  assert.equal((await api("POST", "/generation-runs/not-a-uuid/undo")).status, 404);
});

// ------------------------------------------------------------------ cancel

test("cancel: a run cancelled right after start ends cancelled (or succeeded if it was faster), frees the slot and changes nothing when cancelled", async () => {
  const rev0 = await revOf(w.versionId);
  const g = await generate({ seeds: 5 });
  assert.equal(g.status, 202);
  const c = await api("POST", `/generation-runs/${g.body.run.id}/cancel`);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.success, true);
  const done = await waitRun(g.body.run.id);
  assert.ok(["cancelled", "succeeded"].includes(done.status), done.status);
  if (done.status === "cancelled") {
    assert.equal(c.body.run.status, "cancelled");
    assert.equal(await revOf(w.versionId), rev0);
    assert.equal(placedCount(await placements()), 0);
    assert.equal(done.error_code, null);
    assert.ok(done.finished_at);
    assert.equal(done.after_rev, null);
  }
  // the active slot is free again
  const next = await run({});
  assert.equal(next.status, "succeeded", JSON.stringify(next));
  // finished runs cannot be cancelled
  const again = await api("POST", `/generation-runs/${next.id}/cancel`);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "RUN_NOT_ACTIVE");
  assert.equal((await api("POST", `/generation-runs/${NOPE}/cancel`)).body.code, "RUN_NOT_FOUND");
});

// ------------------------------------------------------------------ stale sweep (heartbeat, contract 9.9)

/** Inserts a run row: `hb` = heartbeat age (null = no heartbeat), `age` = created/started age. */
const mkRun = (status, age, hb = null, extra = {}) =>
  pool.query(
    `INSERT INTO planner_generation_runs (version_id, term_id, mode, status, stage, created_at, started_at, heartbeat_at, instance_id,
                                          before_placements, after_placements, after_rev)
     VALUES ($1, $2, 'fill_unplaced', $3, $3, NOW() - $4::interval, NOW() - $4::interval, CASE WHEN $5::text IS NULL THEN NULL ELSE NOW() - $5::text::interval END, $6,
             COALESCE($7::jsonb, '[]'::jsonb), COALESCE($8::jsonb, '[]'::jsonb), $9)
     RETURNING id`,
    [w.versionId, w.termId, status, age, hb, extra.instance ?? null,
      extra.before ? JSON.stringify(extra.before) : null, extra.after ? JSON.stringify(extra.after) : null, extra.afterRev ?? null]
  ).then((r) => r.rows[0].id);
const runRow = (id) => pool.query("SELECT * FROM planner_generation_runs WHERE id = $1", [id]).then((r) => r.rows[0]);

test("sweepStaleRuns: only rows with no heartbeat for 2 minutes fail (SERVER_RESTART, stage failed); a fresh heartbeat keeps an old run alive; no heartbeat falls back to started_at", async () => {
  const stale = await mkRun("running", "30 minutes", "3 minutes");
  const swept = await sweepStaleRuns();
  assert.ok(swept >= 1);
  const row = await runRow(stale);
  assert.equal(row.status, "failed");
  assert.equal(row.stage, "failed");
  assert.equal(row.error_code, "SERVER_RESTART");
  assert.ok(row.finished_at);

  // fresh heartbeat on an old run: alive
  const alive = await mkRun("running", "45 minutes", "10 seconds");
  await sweepStaleRuns();
  assert.equal((await runRow(alive)).status, "running");
  await pool.query("UPDATE planner_generation_runs SET status = 'failed' WHERE id = $1", [alive]);
  // no heartbeat: created/started 1 minute ago -> alive, 3 minutes ago -> swept
  const young = await mkRun("running", "1 minute");
  await sweepStaleRuns();
  assert.equal((await runRow(young)).status, "running");
  await pool.query("UPDATE planner_generation_runs SET status = 'failed' WHERE id = $1", [young]);
  const old = await mkRun("running", "3 minutes");
  await sweepStaleRuns();
  assert.equal((await runRow(old)).error_code, "SERVER_RESTART");
  // never throws, and a second call has nothing to do
  assert.equal(await sweepStaleRuns(), 0);
});

test("lazy sweep: listing, polling and POST generate fail a dead run first (no waiting for a timer), so a crashed run never blocks the version", async () => {
  const dead = await mkRun("running", "10 minutes", "5 minutes");
  const list = await api("GET", `/versions/${w.versionId}/generation`);
  assert.equal(list.status, 200);
  assert.equal(list.body.active, null);
  assert.equal(list.body.runs[0].id, dead);
  assert.equal(list.body.runs[0].status, "failed");
  assert.equal(list.body.runs[0].error_code, "SERVER_RESTART");

  const dead2 = await mkRun("queued", "10 minutes", "5 minutes");
  const got = await api("GET", `/generation-runs/${dead2}`);
  assert.equal(got.body.run.status, "failed");
  assert.equal(got.body.run.error_code, "SERVER_RESTART");

  const dead3 = await mkRun("running", "10 minutes", "5 minutes");
  const ok = await run({});
  assert.equal(ok.status, "succeeded");
  assert.equal((await runRow(dead3)).error_code, "SERVER_RESTART");
});

test("crash safety: a run that died after a committed chunk (persisted partial after_placements, stale heartbeat) becomes failed SERVER_RESTART and is still undoable", async () => {
  const [C0, C1] = w.rooms.classrooms;
  const a = S(w, "X", "TH1", "ALL", 1);
  const b = S(w, "Y", "TH2");
  const r = await ops(w, [place(w, a, THU, 960, C0), place(w, b, FRI, 960, C1)]); // "chunk 1" as committed by the dying process
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rev = await revOf(w.versionId);
  const nothing = (id) => ({ session_id: id, weekday: null, start_min: null, room_id: null });
  const id = await mkRun("running", "10 minutes", "4 minutes", {
    before: [nothing(a), nothing(b)],
    after: [
      { session_id: a, weekday: THU, start_min: 960, room_id: C0 },
      { session_id: b, weekday: FRI, start_min: 960, room_id: C1 },
    ].sort((x, y) => (x.session_id < y.session_id ? -1 : 1)),
    afterRev: rev,
  });
  const got = await api("GET", `/generation-runs/${id}`);
  assert.equal(got.body.run.status, "failed");
  assert.equal(got.body.run.error_code, "SERVER_RESTART");
  assert.equal(got.body.run.after_rev, rev);

  const u = await api("POST", `/generation-runs/${id}/undo`);
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(u.body.restored, 2);
  assert.deepEqual(u.body.skipped_session_ids, []);
  assert.equal(placedCount(await placements()), 0);
  assert.equal(await occupancyIsConsistent(w.versionId), true);
});

// ------------------------------------------------------------------ in-process runs (service level): hooks, cancel_requested, worker cap

/** Runs `fn` with the test hooks set and console.error silenced (the simulated failures log on purpose). */
async function withHooks(hooks, fn) {
  const saved = { ...__test };
  const err = console.error;
  console.error = () => {};
  Object.assign(__test, hooks);
  try {
    return await fn();
  } finally {
    Object.assign(__test, saved);
    console.error = err;
  }
}
async function waitRow(id) {
  for (let i = 0; i < 300; i++) {
    const row = await runRow(id);
    if (row.status !== "queued" && row.status !== "running") return row;
    await sleep(100);
  }
  throw new Error("run did not finish in 30 s");
}
const placedSlots = async () => {
  const m = await placements();
  return [...m.entries()].filter(([, p]) => p.weekday !== null).map(([id, p]) => ({ session_id: id, weekday: p.weekday, start_min: p.start_min, room_id: p.room_id }))
    .sort((x, y) => (x.session_id < y.session_id ? -1 : 1));
};

test("crash safety, in process: a failure after chunk 1 leaves after_placements = exactly what was applied (not a re-read), after_rev set, and the run is undoable", async () => {
  const rev0 = await revOf(w.versionId);
  const done = await withHooks(
    { chunkSize: 3, afterChunk: async ({ chunk_index }) => { if (chunk_index === 0) throw new Error("simulated crash after chunk 1"); } },
    async () => {
      const r = await createRun(w.versionId, { seeds: 1 }, {});
      return waitRow(r.id);
    }
  );
  assert.equal(done.status, "failed");
  assert.equal(done.error_code, "GENERATION_FAILED");
  assert.equal(done.stage, "failed");
  const applied = await placedSlots();
  assert.ok(applied.length > 0 && applied.length < 9, `partial result: ${applied.length}`);
  assert.deepEqual(done.after_placements, applied);
  assert.equal(Number(done.after_rev), await revOf(w.versionId));
  assert.ok(Number(done.after_rev) > rev0);
  assert.equal(done.before_placements.length, 9);

  const u = await api("POST", `/generation-runs/${done.id}/undo`);
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(u.body.restored, applied.length);
  assert.equal(placedCount(await placements()), 0);
  assert.equal(await occupancyIsConsistent(w.versionId), true);
});

test("cancel_requested: the executing process polls it at every chunk; the run ends cancelled with its committed chunks recorded and undoable", async () => {
  const done = await withHooks(
    {
      chunkSize: 3,
      afterChunk: async ({ chunk_index, run_id }) => {
        if (chunk_index === 0) await pool.query("UPDATE planner_generation_runs SET cancel_requested = TRUE WHERE id = $1", [run_id]); // "another process" asks
      },
    },
    async () => {
      const r = await createRun(w.versionId, { seeds: 1 }, {});
      return waitRow(r.id);
    }
  );
  assert.equal(done.status, "cancelled");
  assert.equal(done.stage, "cancelled");
  assert.equal(done.cancel_requested, true);
  const applied = await placedSlots();
  assert.ok(applied.length > 0 && applied.length < 9, `partial result: ${applied.length}`);
  assert.deepEqual(done.after_placements, applied);
  assert.ok(done.after_rev !== null);
  const u = await api("POST", `/generation-runs/${done.id}/undo`);
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(placedCount(await placements()), 0);
});

test("cancelRun for a run of ANOTHER process sets cancel_requested and returns it; a dead/orphan run is cancelled at once with stage cancelled", async () => {
  const other = await mkRun("running", "1 minute", "5 seconds", { instance: "another-process" });
  const c = await api("POST", `/generation-runs/${other}/cancel`);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.run.status, "running");
  assert.equal((await runRow(other)).cancel_requested, true);
  await pool.query("UPDATE planner_generation_runs SET status = 'failed' WHERE id = $1", [other]);

  const orphan = await mkRun("running", "1 hour", "30 minutes", { instance: "dead-process" });
  const c2 = await api("POST", `/generation-runs/${orphan}/cancel`);
  assert.equal(c2.status, 200, JSON.stringify(c2.body));
  assert.equal(c2.body.run.status, "cancelled");
  const row = await runRow(orphan);
  assert.equal(row.stage, "cancelled");
  assert.ok(row.finished_at);
  assert.equal(row.cancel_requested, false);
});

test("STALE: a session placed by hand while the generation runs is not overwritten; its unit is reported SERVER_REFUSED 'changed while the generation was running'", async () => {
  const [, C1] = w.rooms.classrooms;
  const yth2 = S(w, "Y", "TH2");
  let manual = null;
  const done = await withHooks(
    {
      chunkSize: 3,
      afterChunk: async ({ chunk_index }) => {
        if (chunk_index !== 0 || manual) return;
        for (const day of [FRI, THU, WED]) {
          for (const start of [510, 645, 810, 960]) {
            const r = await ops(w, [place(w, yth2, day, start, C1)]);
            if (r.status === 200) {
              manual = { day, start };
              return;
            }
          }
        }
      },
    },
    async () => {
      const r = await createRun(w.versionId, { seeds: 1 }, {});
      return waitRow(r.id);
    }
  );
  assert.ok(manual, "the manual placement was possible");
  assert.equal(done.status, "succeeded", JSON.stringify(done));
  const entry = done.unplaced.find((u) => u.session_id === yth2);
  assert.ok(entry, JSON.stringify(done.unplaced));
  assert.equal(entry.code, "SERVER_REFUSED");
  assert.equal(entry.text, "changed while the generation was running");
  const p = (await placements()).get(yth2);
  assert.deepEqual([p.weekday, p.start_min, p.room_id], [manual.day, manual.start, C1], "the hand placement stays");
  assert.equal(done.stats.unplaced, done.unplaced.length);
  assert.equal(await occupancyIsConsistent(w.versionId), true);
});

test("undo is atomic with a fallback: a refused restore keeps that session at the slot the run gave it (never left unplaced), the rest is restored, all in one rev bump", async () => {
  await placeOdd();
  const before = await placements();
  const done = await run({ mode: "regenerate_unlocked", confirm: true });
  assert.equal(done.status, "succeeded", JSON.stringify(done));
  const mid = await placements();
  const a = S(w, "X", "TH1", "ALL", 1);
  const b = S(w, "X", "TH1", "ALL", 2); // same teacher as `a`
  assert.notEqual(slot(mid.get(a)), slot(before.get(a)));
  assert.notEqual(slot(mid.get(b)), slot(before.get(b)));
  // doctor the record: b "was" exactly where a was (teacher A cannot be in two places), so restoring b must be refused
  const rowBefore = (await runRow(done.id)).before_placements;
  const ba = rowBefore.find((x) => x.session_id === a);
  const doctored = rowBefore.map((x) => (x.session_id === b ? { ...ba, session_id: b } : x));
  await pool.query("UPDATE planner_generation_runs SET before_placements = $2::jsonb WHERE id = $1", [done.id, JSON.stringify(doctored)]);

  const rev1 = await revOf(w.versionId);
  const u = await api("POST", `/generation-runs/${done.id}/undo`);
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal((await revOf(w.versionId)), rev1 + 1, "one transaction, one bump");
  assert.equal(u.body.refused.length, 1);
  // units go in session-id order: the second of the two to take that slot is the one that is refused
  const loser = u.body.refused[0].session_id;
  const winner = loser === a ? b : a;
  assert.ok([a, b].includes(loser));
  assert.equal(u.body.refused[0].code, "CLASH");
  assert.equal(u.body.refused[0].fallback_applied, true);
  assert.deepEqual(u.body.skipped_session_ids, [loser]);
  assert.equal(u.body.restored, 8);
  const after = await placements();
  assert.equal(slot(after.get(loser)), slot(mid.get(loser)), "the refused one stays where the run put it");
  assert.equal(slot(after.get(winner)), slot(before.get(a)), "the other one is restored to the contested slot");
  assert.ok(after.get(loser).weekday !== null);
  assert.equal(await occupancyIsConsistent(w.versionId), true);
  await assertNoClashes();
  assert.ok((await runRow(done.id)).undone_at, "marked undone in the same transaction");
});

test("undo is refused (NOT_UNDOABLE) while another run is active, and nothing is touched", async () => {
  await placeOdd();
  const done = await run({ mode: "regenerate_unlocked", confirm: true });
  assert.equal(done.status, "succeeded", JSON.stringify(done));
  const mid = await placements();
  const rev1 = await revOf(w.versionId);
  const act = await mkRun("running", "1 second", "1 second");
  const u = await api("POST", `/generation-runs/${done.id}/undo`);
  assert.equal(u.status, 409);
  assert.equal(u.body.code, "NOT_UNDOABLE");
  assert.equal(await revOf(w.versionId), rev1);
  assert.deepEqual([...(await placements()).values()].map(slot).sort(), [...mid.values()].map(slot).sort());
  await pool.query("UPDATE planner_generation_runs SET status = 'failed' WHERE id = $1", [act]);
});

// ------------------------------------------------------------------ retention + worker cap

test("retention: only the newest 20 runs of a version are kept; an active run is never deleted", async () => {
  const ids = [];
  for (let i = 0; i < 24; i++) ids.push(await mkRun("failed", `${100 - i} minutes`));
  const active = await mkRun("running", "3 days", "1 second"); // oldest of all, but active
  const removed = await pruneRuns(w.versionId);
  assert.equal(removed, 4);
  const left = (await pool.query("SELECT id FROM planner_generation_runs WHERE version_id = $1", [w.versionId])).rows.map((r) => r.id);
  assert.equal(left.length, 21);
  assert.ok(left.includes(active), "the active run survives");
  assert.ok(left.includes(ids[4]) && left.includes(ids[23]), "the newest 20 finished runs survive");
  assert.ok(!left.includes(ids[0]) && !left.includes(ids[3]), "the oldest finished runs are gone");
  await pool.query("UPDATE planner_generation_runs SET status = 'failed' WHERE id = $1", [active]);
  // and it happens by itself when a run finishes
  for (let i = 0; i < 22; i++) await mkRun("failed", `${50 - i} minutes`);
  const ok = await run({});
  assert.equal(ok.status, "succeeded");
  for (let i = 0; i < 50; i++) {
    const n = (await pool.query("SELECT count(*)::int AS n FROM planner_generation_runs WHERE version_id = $1", [w.versionId])).rows[0].n;
    if (n <= 20) break;
    await sleep(100);
  }
  assert.ok((await pool.query("SELECT count(*)::int AS n FROM planner_generation_runs WHERE version_id = $1", [w.versionId])).rows[0].n <= 20);
  assert.ok(await runRow(ok.id), "the newest run is kept");
});

test("worker cap: with every slot busy a run stays queued (stage queued) until a slot frees; a queued run can be cancelled", async () => {
  const saved = workerSlots().max;
  setMaxWorkers(1);
  const hold = await acquireWorkerSlot(); // another run's thread
  try {
    const r1 = await createRun(w.versionId, { seeds: 1 }, {});
    await sleep(700);
    let row = await runRow(r1.id);
    assert.equal(row.status, "queued");
    assert.equal(row.stage, "queued");
    assert.equal(workerSlots().waiting, 1);
    // cancel the queued run: ends cancelled, frees the version, never started
    const t0 = Date.now();
    const c = await cancelRun(r1.id);
    assert.equal(c.status, "cancelled");
    assert.ok(Date.now() - t0 < 2500, "cancelling a queued run does not wait for a slot");
    row = await runRow(r1.id);
    assert.equal(row.stage, "cancelled");
    assert.equal(row.started_at, null);
    assert.equal(workerSlots().waiting, 0);

    // a second run starts as soon as the slot is released
    const r2 = await createRun(w.versionId, { seeds: 1 }, {});
    await sleep(300);
    assert.equal((await runRow(r2.id)).status, "queued");
    hold();
    const fin = await waitRow(r2.id);
    assert.equal(fin.status, "succeeded", JSON.stringify(fin));
  } finally {
    hold();
    setMaxWorkers(saved);
  }
  assert.equal(workerSlots().running, 0);
});

test("acquireWorkerSlot: FIFO, at most max at a time, abortWait rejects a waiter with CANCELLED", async () => {
  const saved = workerSlots().max;
  setMaxWorkers(2);
  try {
    const r1 = await acquireWorkerSlot();
    const r2 = await acquireWorkerSlot();
    const handle = {};
    let third = "pending";
    const p3 = acquireWorkerSlot(handle).then((rel) => { third = "got"; return rel; }, (e) => { third = e.code; });
    await sleep(50);
    assert.equal(third, "pending");
    assert.deepEqual([workerSlots().running, workerSlots().waiting], [2, 1]);
    r1();
    const rel3 = await p3;
    assert.equal(third, "got");
    assert.deepEqual([workerSlots().running, workerSlots().waiting], [2, 0]);
    r1(); // idempotent
    assert.equal(workerSlots().running, 2);
    const h2 = {};
    const p4 = acquireWorkerSlot(h2).then(() => "got", (e) => e.code);
    await sleep(20);
    h2.abortWait();
    assert.equal(await p4, "CANCELLED");
    r2();
    rel3();
    assert.equal(workerSlots().running, 0);
  } finally {
    setMaxWorkers(saved);
  }
});
