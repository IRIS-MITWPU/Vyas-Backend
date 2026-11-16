// Planner API: review round 2 fixes (concurrency guards, structural-edit guards, parser limits, socket
// join/leave ordering, CONFLICT_RETRY mapping). The race tests are deterministic: a second connection holds the
// version row lock (what an editor op holds while it places a session), the HTTP request is fired and we wait
// until Postgres reports it blocked behind that lock, then a placement is committed under the lock. A request that
// took the lock first thing sees the placement and refuses; the old code answered 200 here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io as ioClient } from "socket.io-client";
import { pool, openSessions, newUid, scope, cleanup, makeTerm, makeFaculty, BASE_URL } from "./_util.js";
import { buildWorld, S, ops, place, revOf, occOf, occCount, occupancyIsConsistent, MON, TUE, WED } from "./_editorUtil.js";

const s = scope(newUid());
let sessions;
let api;
const sockets = [];

before(async () => {
  sessions = await openSessions();
  api = sessions.api;
});
after(async () => {
  for (const sock of sockets) sock.close();
  await cleanup(s, sessions);
});

// ------------------------------------------------------------------ helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A second connection that holds the version row lock until commit()/rollback(). */
async function holdVersionLock(versionId) {
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT id FROM planner_versions WHERE id = $1 FOR UPDATE", [versionId]);
  const { rows: [{ pid }] } = await client.query("SELECT pg_backend_pid() AS pid");
  return {
    client,
    pid,
    async release(how = "COMMIT") {
      try { await client.query(how); } finally { client.release(); }
    },
  };
}

/** Resolves once some backend is blocked behind `holder` (so the request really is waiting on the lock). */
async function waitBlocked(holder, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const { rows: [{ n }] } = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [holder.pid]);
    if (n > 0) return;
    await sleep(40);
  }
  throw new Error("the request never blocked on the version lock");
}

/** Fires `request()` while the version lock is held, places a session under that lock, commits, returns the response. */
async function raceWithPlacement(versionId, request, sessionId, roomId) {
  const holder = await holdVersionLock(versionId);
  let released = false;
  try {
    const pending = request();
    let early = null;
    pending.then((r) => { early = r; }, () => {});
    await waitBlocked(holder);
    assert.equal(early, null, "the request must wait for the version lock");
    await holder.client.query(
      "UPDATE planner_sessions SET weekday = 0, start_min = 510, end_min = 570, room_id = $2 WHERE id = $1",
      [sessionId, roomId]
    );
    await holder.release();
    released = true;
    return await pending;
  } finally {
    if (!released) await holder.release("ROLLBACK");
  }
}

async function rooms() {
  const classroom = (await pool.query("SELECT id FROM rooms WHERE is_active AND room_type = 'classroom' AND capacity >= 30 ORDER BY name LIMIT 1")).rows[0].id;
  const lab = (await pool.query("SELECT id FROM rooms WHERE is_active AND room_type = 'lab' AND capacity >= 30 ORDER BY name LIMIT 1")).rows[0].id;
  return { classroom, lab };
}

/**
 * One term: division D (sem 3, 30 students) with batches B1 B2 (15 each); subjects TH (theory), LB (lab, per batch),
 * LW (lab, whole division); offerings of all three; sessions synced:
 *   TH/ALL, LB/B1, LB/B2, LW/ALL. Pool: one classroom + one lab (capacity >= 30).
 */
async function mini(tag, { sync = true } = {}) {
  const term = await makeTerm(api, s);
  const rm = await rooms();
  const add = await api("POST", `/terms/${term.id}/rooms`, { room_ids: [rm.classroom, rm.lab] });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const fac = {};
  for (const n of ["A", "B", "C"]) fac[n] = await makeFaculty(api, s, `${tag}${n}`);
  const mk = async (body) => {
    const r = await api("POST", `/terms/${term.id}/subjects`, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.subject;
  };
  const subj = {
    TH: await mk({ code: "TH", name: "Theory", kind: "theory", weekly_count: 1 }),
    LB: await mk({ code: "LB", name: "Lab", kind: "lab", weekly_count: 1 }),
    LW: await mk({ code: "LW", name: "Whole lab", kind: "lab", weekly_count: 1 }),
  };
  const dr = await api("POST", `/terms/${term.id}/divisions`, {
    semester: 3, name: "D", student_count: 30, batches: [{ name: "B1", student_count: 15 }, { name: "B2", student_count: 15 }],
  });
  assert.equal(dr.status, 201, JSON.stringify(dr.body));
  const D = dr.body.division;
  const bt = Object.fromEntries(D.batches.map((b) => [b.name, b.id]));
  const off = async (subject, faculty, extra = {}) => {
    const r = await api("POST", `/terms/${term.id}/offerings`, { division_id: D.id, subject_id: subject.id, faculty, ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.offering;
  };
  const offerings = {
    TH: await off(subj.TH, [{ faculty_id: fac.A.id }]),
    LB: await off(subj.LB, [{ faculty_id: fac.B.id }]),
    LW: await off(subj.LW, [{ faculty_id: fac.C.id }], { per_batch: false }),
  };
  const m = { term, termId: term.id, versionId: term.versionId, rm, fac, subj, D, bt, offerings, api };
  if (sync) {
    const r = await api("POST", `/versions/${term.versionId}/sync-sessions`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.added, 4);
    await mini.refresh(m);
  }
  return m;
}
mini.refresh = async (m) => {
  const r = await api("GET", `/versions/${m.versionId}/sessions`);
  m.sessions = new Map(r.body.sessions.map((x) => [`${x.subject_code}/${x.batch_name}`, x.id]));
};
const sid = (m, key) => {
  const id = m.sessions.get(key);
  if (!id) throw new Error(`no session ${key}`);
  return id;
};
const placeOps = (m, key, weekday, start, room) => ops(m, [place(m, sid(m, key), weekday, start, room)]);
// _editorUtil's ops() wants { versionId, api }
const sessionCount = async (versionId) => (await pool.query("SELECT count(*)::int AS n FROM planner_sessions WHERE version_id = $1", [versionId])).rows[0].n;

// ------------------------------------------------------------------ socket helpers (as in socket.test.js)

const connect = (cookie) =>
  new Promise((resolve, reject) => {
    const sock = ioClient(BASE_URL, { extraHeaders: { Cookie: cookie }, transports: ["websocket"], reconnection: false });
    sockets.push(sock);
    sock.once("connect", () => resolve(sock));
    sock.once("connect_error", reject);
  });
const emitAck = (sock, event, payload) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ack for ${event}`)), 8000);
    sock.emit(event, payload, (res) => {
      clearTimeout(t);
      resolve(res);
    });
  });
const nextEvent = (sock, ms = 4000) =>
  new Promise((resolve) => {
    const t = setTimeout(() => {
      sock.off("planner:changed", on);
      resolve(null);
    }, ms);
    const on = (p) => {
      clearTimeout(t);
      resolve(p);
    };
    sock.once("planner:changed", on);
  });

// ================================================================== 1. PATCH /terms vs placements

test("fix 1: PATCH /terms of a grid setting takes the version locks before counting placed sessions", async () => {
  const m = await mini("T1");
  const before_ = (await api("GET", `/terms/${m.termId}`)).body.term;
  const res = await raceWithPlacement(m.versionId, () => api("PATCH", `/terms/${m.termId}`, { day_end_min: before_.day_end_min - 60 }), sid(m, "TH/ALL"), m.rm.classroom);
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "LOCKED_BY_PLACEMENTS");
  assert.deepEqual(res.body.details.fields, ["day_end_min"]);
  assert.equal((await api("GET", `/terms/${m.termId}`)).body.term.day_end_min, before_.day_end_min, "nothing was written");

  // a setting that is not grid-defining does not need the locks: it goes through while a placement holds the lock
  const holder = await holdVersionLock(m.versionId);
  try {
    const free = await api("PATCH", `/terms/${m.termId}`, { start_date: "2026-08-03" });
    assert.equal(free.status, 200, JSON.stringify(free.body));
  } finally {
    await holder.release("ROLLBACK");
  }
});

// ================================================================== 2. pool rooms

test("fix 2: removing a pool room waits for in-flight placements and keeps the IN_USE guard", async () => {
  const m = await mini("T2a");
  const poolRow = (await api("GET", `/terms/${m.termId}/rooms`)).body.rooms.find((r) => r.room_id === m.rm.classroom);
  const res = await raceWithPlacement(m.versionId, () => api("DELETE", `/terms/${m.termId}/rooms/${poolRow.id}`), sid(m, "TH/ALL"), m.rm.classroom);
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "IN_USE");
  assert.ok((await api("GET", `/terms/${m.termId}/rooms`)).body.rooms.some((r) => r.id === poolRow.id), "the room is still in the pool");
  // the other (unused) room can be removed
  const labRow = (await api("GET", `/terms/${m.termId}/rooms`)).body.rooms.find((r) => r.room_id === m.rm.lab);
  assert.equal((await api("DELETE", `/terms/${m.termId}/rooms/${labRow.id}`)).status, 200);
});

test("fix 2: is_lab cannot be flipped while a placed session uses the room; other updates are unchanged", async () => {
  const m = await mini("T2b");
  const rowOf = async (roomId) => (await api("GET", `/terms/${m.termId}/rooms`)).body.rooms.find((r) => r.room_id === roomId);
  const lab = await rowOf(m.rm.lab);
  assert.equal(lab.is_lab, true);
  // nothing placed: flipping is fine, and so is flipping back
  assert.equal((await api("PATCH", `/terms/${m.termId}/rooms/${lab.id}`, { is_lab: false })).status, 200);
  assert.equal((await api("PATCH", `/terms/${m.termId}/rooms/${lab.id}`, { is_lab: true })).status, 200);

  assert.equal((await placeOps(m, "LB/B1", MON, 510, m.rm.lab)).status, 200);
  const flip = await api("PATCH", `/terms/${m.termId}/rooms/${lab.id}`, { is_lab: false });
  assert.equal(flip.status, 409, JSON.stringify(flip.body));
  assert.equal(flip.body.code, "LOCKED_BY_PLACEMENTS");
  assert.deepEqual(flip.body.details.fields, ["is_lab"]);
  assert.match(flip.body.error, /placed in this room/);
  assert.equal((await rowOf(m.rm.lab)).is_lab, true);
  // writing the value it already has is not a flip
  assert.equal((await api("PATCH", `/terms/${m.termId}/rooms/${lab.id}`, { is_lab: true })).status, 200);
  // the classroom (nobody placed in it) can still flip
  const cls = await rowOf(m.rm.classroom);
  assert.equal((await api("PATCH", `/terms/${m.termId}/rooms/${cls.id}`, { is_lab: true })).status, 200);
  // after unplacing, the lab flips again
  assert.equal((await ops(m, [{ op: "unplace", session_id: sid(m, "LB/B1") }])).status, 200);
  assert.equal((await api("PATCH", `/terms/${m.termId}/rooms/${lab.id}`, { is_lab: false })).status, 200);

  // race: a placement in flight under the version lock makes the flip refuse
  const res = await raceWithPlacement(m.versionId, () => api("PATCH", `/terms/${m.termId}/rooms/${lab.id}`, { is_lab: true }), sid(m, "LB/B1"), m.rm.lab);
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "LOCKED_BY_PLACEMENTS");
  assert.equal((await rowOf(m.rm.lab)).is_lab, false);
});

// ================================================================== 3. deletes

test("fix 3: deleting an offering removes its unplaced sessions, bumps rev, emits planner:changed; never removes a placed one", async () => {
  const m = await mini("T3a");
  const admin = await connect(sessions.admin.cookie);
  assert.deepEqual(await emitAck(admin, "join:planner", { version_id: m.versionId }), { ok: true });

  // a placed session blocks the delete: nothing deleted, rev unchanged, no event
  assert.equal((await placeOps(m, "TH/ALL", MON, 510, m.rm.classroom)).status, 200);
  const rev0 = await revOf(m.versionId);
  const quiet = nextEvent(admin, 800);
  const refused = await api("DELETE", `/terms/${m.termId}/offerings/${m.offerings.TH.id}`);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "HAS_PLACED_SESSIONS");
  assert.equal(await sessionCount(m.versionId), 4);
  assert.equal(await revOf(m.versionId), rev0);
  assert.equal(await quiet, null);
  assert.ok(await occupancyIsConsistent(m.versionId));

  // an unplaced offering: sessions removed, rev + 1, one refetch event
  const waiting = nextEvent(admin);
  const del = await api("DELETE", `/terms/${m.termId}/offerings/${m.offerings.LB.id}`);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(await sessionCount(m.versionId), 2, "the two LB sessions are gone, TH and LW stay");
  assert.equal(await revOf(m.versionId), rev0 + 1);
  assert.deepEqual(await waiting, { version_id: m.versionId, rev: rev0 + 1, prev_rev: rev0, client_id: null, sessions: null, refetch: true });
  assert.ok(await occupancyIsConsistent(m.versionId));

  // an offering without any session changes nothing and emits nothing
  const bare = await mini("T3a2", { sync: false });
  const adminJoin = await emitAck(admin, "join:planner", { version_id: bare.versionId });
  assert.deepEqual(adminJoin, { ok: true });
  const none = nextEvent(admin, 800);
  assert.equal((await api("DELETE", `/terms/${bare.termId}/offerings/${bare.offerings.TH.id}`)).status, 200);
  assert.equal(await revOf(bare.versionId), 0);
  assert.equal(await none, null);
});

test("fix 3: a placement committed while an offering delete waits is never deleted (race)", async () => {
  const m = await mini("T3b");
  const res = await raceWithPlacement(m.versionId, () => api("DELETE", `/terms/${m.termId}/offerings/${m.offerings.TH.id}`), sid(m, "TH/ALL"), m.rm.classroom);
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "HAS_PLACED_SESSIONS");
  const { rows } = await pool.query("SELECT weekday FROM planner_sessions WHERE id = $1", [sid(m, "TH/ALL")]);
  assert.equal(rows.length, 1, "the placed session survived");
  assert.equal(rows[0].weekday, 0);
});

test("fix 3: deleting a division removes its unplaced sessions, bumps rev and emits; a placed one blocks (also in a race)", async () => {
  const m = await mini("T3c");
  const admin = await connect(sessions.admin.cookie);
  assert.deepEqual(await emitAck(admin, "join:planner", { version_id: m.versionId }), { ok: true });

  const race = await raceWithPlacement(m.versionId, () => api("DELETE", `/terms/${m.termId}/divisions/${m.D.id}`), sid(m, "LW/ALL"), m.rm.lab);
  assert.equal(race.status, 409, JSON.stringify(race.body));
  assert.equal(race.body.code, "HAS_PLACED_SESSIONS");
  assert.equal(await sessionCount(m.versionId), 4);

  await pool.query("UPDATE planner_sessions SET weekday = NULL, start_min = NULL, end_min = NULL, room_id = NULL WHERE id = $1", [sid(m, "LW/ALL")]);
  const rev0 = await revOf(m.versionId);
  const waiting = nextEvent(admin);
  const del = await api("DELETE", `/terms/${m.termId}/divisions/${m.D.id}`);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(await sessionCount(m.versionId), 0);
  assert.equal(await revOf(m.versionId), rev0 + 1);
  assert.deepEqual(await waiting, { version_id: m.versionId, rev: rev0 + 1, prev_rev: rev0, client_id: null, sessions: null, refetch: true });
});

test("fix 3: deleting a batch removes its unplaced sessions and its 'batch' occupancy rows, bumps rev and emits", async () => {
  const m = await mini("T3d");
  const admin = await connect(sessions.admin.cookie);
  assert.deepEqual(await emitAck(admin, "join:planner", { version_id: m.versionId }), { ok: true });

  // a whole-division lecture writes one 'batch' occupancy row per batch (B1, B2) plus the whole batch
  assert.equal((await placeOps(m, "TH/ALL", TUE, 510, m.rm.classroom)).status, 200);
  const rowsFor = (id) => occCount(m.versionId, "kind = 'batch' AND resource_id = $2", [id]);
  assert.equal(await rowsFor(m.bt.B1), 1);
  assert.equal(await rowsFor(m.bt.B2), 1);

  // B1's lab session is placed: the delete is refused and nothing changes
  assert.equal((await placeOps(m, "LB/B1", MON, 510, m.rm.lab)).status, 200);
  const rev0 = await revOf(m.versionId);
  const refused = await api("DELETE", `/terms/${m.termId}/divisions/${m.D.id}/batches/${m.bt.B1}`);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "HAS_PLACED_SESSIONS");
  assert.equal(await rowsFor(m.bt.B1), 2, "B1 keeps its rows (lecture + its own lab)");
  assert.equal(await sessionCount(m.versionId), 4);

  // B2 has an unplaced lab session only
  const waiting = nextEvent(admin);
  const del = await api("DELETE", `/terms/${m.termId}/divisions/${m.D.id}/batches/${m.bt.B2}`);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(await sessionCount(m.versionId), 3, "LB/B2 is gone");
  assert.equal(await rowsFor(m.bt.B2), 0, "no occupancy row of the deleted batch is left");
  assert.equal(await rowsFor(m.bt.B1), 2);
  assert.equal(await revOf(m.versionId), rev0 + 1);
  assert.deepEqual(await waiting, { version_id: m.versionId, rev: rev0 + 1, prev_rev: rev0, client_id: null, sessions: null, refetch: true });
  assert.ok(await occupancyIsConsistent(m.versionId));
  const orphan = await pool.query(
    "SELECT 1 FROM planner_occupancy o WHERE o.version_id = $1 AND o.kind = 'batch' AND NOT EXISTS (SELECT 1 FROM planner_batches b WHERE b.id = o.resource_id)",
    [m.versionId]
  );
  assert.equal(orphan.rows.length, 0);

  // race on the remaining batch: a placement under the lock wins
  await pool.query("DELETE FROM planner_occupancy WHERE session_id = $1", [sid(m, "LB/B1")]);
  await pool.query("UPDATE planner_sessions SET weekday = NULL, start_min = NULL, end_min = NULL, room_id = NULL WHERE id = $1", [sid(m, "LB/B1")]);
  const race = await raceWithPlacement(m.versionId, () => api("DELETE", `/terms/${m.termId}/divisions/${m.D.id}/batches/${m.bt.B1}`), sid(m, "LB/B1"), m.rm.lab);
  assert.equal(race.status, 409, JSON.stringify(race.body));
  assert.equal(race.body.code, "HAS_PLACED_SESSIONS");
  assert.equal((await pool.query("SELECT 1 FROM planner_batches WHERE id = $1", [m.bt.B1])).rows.length, 1);
});

// ================================================================== 4. structural-edit guards

test("fix 4a: a subject's kind cannot change while any of its sessions is placed (API and import)", async () => {
  const m = await mini("T4a");
  // not placed yet: allowed (and back again)
  assert.equal((await api("PATCH", `/terms/${m.termId}/subjects/${m.subj.LB.id}`, { kind: "theory" })).status, 200);
  assert.equal((await api("PATCH", `/terms/${m.termId}/subjects/${m.subj.LB.id}`, { kind: "lab" })).status, 200);

  assert.equal((await placeOps(m, "LB/B1", MON, 510, m.rm.lab)).status, 200);
  const res = await api("PATCH", `/terms/${m.termId}/subjects/${m.subj.LB.id}`, { kind: "theory" });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "LOCKED_BY_PLACEMENTS");
  assert.deepEqual(res.body.details.fields, ["kind"]);
  assert.match(res.body.error, /kind/);
  const both = await api("PATCH", `/terms/${m.termId}/subjects/${m.subj.LB.id}`, { kind: "theory", duration_min: 45 });
  assert.equal(both.status, 409);
  assert.deepEqual(both.body.details.fields, ["duration_min", "kind"]);
  assert.equal((await api("GET", `/terms/${m.termId}/subjects`)).body.subjects.find((x) => x.id === m.subj.LB.id).kind, "lab");
  // the same kind and other fields still go through
  const ok = await api("PATCH", `/terms/${m.termId}/subjects/${m.subj.LB.id}`, { kind: "lab", name: "Renamed lab" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // a subject without placed sessions is unaffected
  assert.equal((await api("PATCH", `/terms/${m.termId}/subjects/${m.subj.LW.id}`, { kind: "theory" })).status, 200);

  // import: a changed kind is a row error (dry run and real run); the same kind is fine
  const row = (kind) => ({ code: "LB", name: "Lab", kind, weekly_count: 1 });
  const dry = await api("POST", `/terms/${m.termId}/import/subjects?dryRun=true`, { rows: [row("theory")] });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.summary.error, 1);
  assert.equal(dry.body.rows[0].errors[0].field, "kind");
  assert.match(dry.body.rows[0].errors[0].message, /placed/);
  const real = await api("POST", `/terms/${m.termId}/import/subjects?dryRun=false`, { rows: [row("theory")] });
  assert.equal(real.status, 422);
  assert.equal(real.body.code, "IMPORT_HAS_ERRORS");
  assert.equal((await api("GET", `/terms/${m.termId}/subjects`)).body.subjects.find((x) => x.id === m.subj.LB.id).kind, "lab");
  const same = await api("POST", `/terms/${m.termId}/import/subjects?dryRun=false`, { rows: [row("lab")] });
  assert.equal(same.status, 200, JSON.stringify(same.body));
});

test("fix 4b: student_count of a division / batch is locked only while a placed session of it sits in a shared lab room", async () => {
  const m = await mini("T4b");
  const patchBatch = (id, student_count) => api("PATCH", `/terms/${m.termId}/divisions/${m.D.id}/batches/${id}`, { student_count });
  const patchDiv = (student_count) => api("PATCH", `/terms/${m.termId}/divisions/${m.D.id}`, { student_count });

  // B1's lab is placed in the (shareable) lab room
  assert.equal((await placeOps(m, "LB/B1", MON, 510, m.rm.lab)).status, 200);
  assert.deepEqual((await occOf(sid(m, "LB/B1"))).filter((r) => r.kind === "lab_room").length, 1, "a lab_room row exists");

  const locked = await patchBatch(m.bt.B1, 14);
  assert.equal(locked.status, 409, JSON.stringify(locked.body));
  assert.equal(locked.body.code, "LOCKED_BY_PLACEMENTS");
  assert.deepEqual(locked.body.details.fields, ["student_count"]);
  assert.equal((await patchBatch(m.bt.B1, 15)).status, 200, "the same number is not a change");
  assert.equal((await api("PATCH", `/terms/${m.termId}/divisions/${m.D.id}/batches/${m.bt.B1}`, { name: "B1x" })).status, 200, "other fields are fine");
  assert.equal((await patchBatch(m.bt.B2, 12)).status, 200, "a batch without placed lab sessions can change");
  // the division's own count only matters for its whole-division sessions
  assert.equal((await patchDiv(32)).status, 200, "no whole-division lab is placed");
  assert.equal((await patchDiv(30)).status, 200);

  // a whole-division lab in the lab room (30 students fit) locks the division count
  assert.equal((await placeOps(m, "LW/ALL", TUE, 510, m.rm.lab)).status, 200);
  const dl = await patchDiv(31);
  assert.equal(dl.status, 409, JSON.stringify(dl.body));
  assert.equal(dl.body.code, "LOCKED_BY_PLACEMENTS");
  assert.equal((await patchDiv(30)).status, 200);
  assert.equal((await api("PATCH", `/terms/${m.termId}/divisions/${m.D.id}`, { name: "D2" })).status, 200, "other fields are fine");
  // a lecture in a classroom does not lock anything
  assert.equal((await placeOps(m, "TH/ALL", WED, 510, m.rm.classroom)).status, 200);

  // import: the same rules as row errors
  const rows = (div, b1, b2) => [
    { semester: 3, division: "D2", student_count: div, batch: "B1x", batch_size: b1 },
    { semester: 3, division: "D2", student_count: div, batch: "B2", batch_size: b2 },
  ];
  const sizeB1 = await api("POST", `/terms/${m.termId}/import/divisions?dryRun=true`, { rows: rows(30, 10, 12) });
  assert.equal(sizeB1.status, 200, JSON.stringify(sizeB1.body));
  assert.equal(sizeB1.body.rows[0].status, "error");
  assert.equal(sizeB1.body.rows[0].errors[0].field, "batch_size");
  assert.notEqual(sizeB1.body.rows[1].status, "error", "B2 has no placed lab session");
  const countDiv = await api("POST", `/terms/${m.termId}/import/divisions?dryRun=true`, { rows: rows(33, 15, 12) });
  assert.equal(countDiv.body.rows[0].status, "error");
  assert.equal(countDiv.body.rows[0].errors[0].field, "student_count");
  const realBad = await api("POST", `/terms/${m.termId}/import/divisions?dryRun=false`, { rows: rows(30, 10, 12) });
  assert.equal(realBad.status, 422);
  assert.equal(realBad.body.code, "IMPORT_HAS_ERRORS");
  assert.equal((await patchBatch(m.bt.B1, 15)).status, 200);
  // unchanged numbers (a blank batch_size keeps the stored one) import fine
  const good = await api("POST", `/terms/${m.termId}/import/divisions?dryRun=false`, { rows: rows(30, 15, 12) });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  const blank = await api("POST", `/terms/${m.termId}/import/divisions?dryRun=false`, { rows: rows(30, "", 11) });
  assert.equal(blank.status, 200, JSON.stringify(blank.body));

  // after unplacing the lab sessions everything is editable again
  assert.equal((await ops(m, [{ op: "unplace", session_id: sid(m, "LB/B1") }, { op: "unplace", session_id: sid(m, "LW/ALL") }])).status, 200);
  assert.equal((await patchBatch(m.bt.B1, 14)).status, 200);
  assert.equal((await patchDiv(31)).status, 200);
});

// ================================================================== 5. body parser limits

test("fix 5: /planner bodies are limited to 100 KB, except the import routes (2 MB)", async () => {
  const pad = (n) => "a".repeat(n);
  // a 150 KB body to an ordinary planner route is refused as too large
  const big = await api("POST", "/terms", { half: "odd", academic_year: pad(150_000) });
  assert.equal(big.status, 413);
  const bigPatch = await api("PATCH", "/terms/00000000-0000-4000-8000-000000000000", { branch: pad(150_000) });
  assert.equal(bigPatch.status, 413);
  // a 90 KB body is read (and then fails validation, which proves it got past the parser)
  const fine = await api("POST", "/terms", { half: "bad", junk: pad(90_000) });
  assert.equal(fine.status, 400, JSON.stringify(fine.body).slice(0, 200));

  // an import dry run of ~1.5 MB (2000 rows with a padded extra column) is accepted
  const m = await mini("T5", { sync: false });
  const rows = Array.from({ length: 2000 }, (_, i) => ({ code: `P${i}`, name: `Padded ${i}`, kind: "theory", weekly_count: 1, notes: pad(700) }));
  const body = JSON.stringify({ rows });
  assert.ok(body.length > 1_400_000 && body.length < 2_000_000, `body is ${body.length} bytes`);
  const dry = await api("POST", `/terms/${m.termId}/import/subjects?dryRun=true`, { rows });
  assert.equal(dry.status, 200, JSON.stringify(dry.body).slice(0, 200));
  assert.equal(dry.body.summary.total, 2000);
  // over 2 MB is refused on the import route too
  const huge = Array.from({ length: 2000 }, (_, i) => ({ code: `P${i}`, name: `Padded ${i}`, kind: "theory", weekly_count: 1, notes: pad(1100) }));
  const tooBig = await api("POST", `/terms/${m.termId}/import/subjects?dryRun=true`, { rows: huge });
  assert.equal(tooBig.status, 413);
  // the 2 MB limit is for the import routes only
  const other = await api("POST", `/terms/${m.termId}/subjects`, { code: "X", name: "x", kind: "theory", weekly_count: 1, notes: pad(150_000) });
  assert.equal(other.status, 413);
});

// ================================================================== 6. socket join/leave ordering

test("fix 6: leave after a join that is still in flight takes effect, and the slot accounting stays exact", async () => {
  const w = await buildWorld(api, s, { tag: "S" });
  const admin = await connect(sessions.admin.cookie);
  const th = S(w, "X", "TH1");

  // join + leave sent back to back: the socket ends up outside the room (no events), both acked ok
  const [j, l] = await Promise.all([emitAck(admin, "join:planner", { version_id: w.versionId }), emitAck(admin, "leave:planner", { version_id: w.versionId })]);
  assert.deepEqual(j, { ok: true });
  assert.deepEqual(l, { ok: true });
  const silent = nextEvent(admin, 800);
  await ops(w, [{ op: "lock", session_id: th }]);
  assert.equal(await silent, null, "left the room");

  // leave + join back to back (leave first): ends up inside
  await Promise.all([emitAck(admin, "leave:planner", { version_id: w.versionId }), emitAck(admin, "join:planner", { version_id: w.versionId })]);
  const heard = nextEvent(admin);
  await ops(w, [{ op: "unlock", session_id: th }]);
  assert.ok(await heard, "joined the room");

  // join, leave, join in a burst (a React remount): inside
  const acks = await Promise.all(["join", "leave", "join"].map((e) => emitAck(admin, `${e}:planner`, { version_id: w.versionId })));
  assert.deepEqual(acks, [{ ok: true }, { ok: true }, { ok: true }]);
  const heard2 = nextEvent(admin);
  await ops(w, [{ op: "lock", session_id: th }]);
  assert.ok(await heard2);
  await emitAck(admin, "leave:planner", { version_id: w.versionId });
});

test("fix 6: rapid join+leave pairs across many versions never leak slots; leaving a room never joined frees nothing", async () => {
  const versions = [];
  for (let i = 0; i < 26; i++) {
    const t = await api("POST", "/terms", { academic_year: s.year(), half: "odd" });
    assert.equal(t.status, 201);
    versions.push(t.body.version.id);
  }
  const admin = await connect(sessions.admin.cookie);

  // 26 join+leave pairs fired without waiting: the first 20 joins are admitted, the rest are over the cap
  // (a leave only frees its slot once it ran), every ack arrives, and nothing is left reserved afterwards
  const pending = [];
  for (const v of versions) {
    pending.push(emitAck(admin, "join:planner", { version_id: v }));
    pending.push(emitAck(admin, "leave:planner", { version_id: v }));
  }
  const acks = await Promise.all(pending);
  const joinAcks = acks.filter((_, i) => i % 2 === 0);
  const leaveAcks = acks.filter((_, i) => i % 2 === 1);
  assert.ok(joinAcks.filter((a) => a.ok).length >= 20, "at least the first 20 joins are admitted");
  assert.ok(joinAcks.filter((a) => !a.ok).every((a) => a.error === "Too many joined rooms"));
  assert.ok(leaveAcks.every((a) => a.ok));

  // the cap is intact: exactly 20 fresh joins succeed, the 21st does not
  for (let i = 0; i < 20; i++) assert.deepEqual(await emitAck(admin, "join:planner", { version_id: versions[i] }), { ok: true }, `join ${i}`);
  assert.deepEqual(await emitAck(admin, "join:planner", { version_id: versions[20] }), { ok: false, error: "Too many joined rooms" });
  // leaving rooms that were never joined frees nothing
  for (const v of versions.slice(21)) assert.deepEqual(await emitAck(admin, "leave:planner", { version_id: v }), { ok: true });
  assert.deepEqual(await emitAck(admin, "join:planner", { version_id: versions[20] }), { ok: false, error: "Too many joined rooms" });
  // a real leave frees exactly one slot
  assert.deepEqual(await emitAck(admin, "leave:planner", { version_id: versions[0] }), { ok: true });
  assert.deepEqual(await emitAck(admin, "join:planner", { version_id: versions[20] }), { ok: true });
  assert.deepEqual(await emitAck(admin, "join:planner", { version_id: versions[21] }), { ok: false, error: "Too many joined rooms" });
});

// ================================================================== 7. CONFLICT_RETRY

test("fix 7: an ops request that waits more than 10 s for the version lock answers 409 CONFLICT_RETRY", async () => {
  const m = await mini("T7");
  const rev0 = await revOf(m.versionId);
  const holder = await holdVersionLock(m.versionId);
  let res;
  try {
    const t0 = Date.now();
    res = await ops(m, [place(m, sid(m, "TH/ALL"), MON, 510, m.rm.classroom)]);
    const waited = Date.now() - t0;
    assert.ok(waited >= 9000 && waited < 20000, `waited ${waited} ms`);
  } finally {
    await holder.release("ROLLBACK");
  }
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "CONFLICT_RETRY");
  assert.equal(res.body.error, "The timetable changed at the same time. Please try again.");
  assert.equal(res.body.details, undefined);
  // nothing was applied and the next request works
  assert.equal(await revOf(m.versionId), rev0);
  assert.equal((await placeOps(m, "TH/ALL", MON, 510, m.rm.classroom)).status, 200);
});
