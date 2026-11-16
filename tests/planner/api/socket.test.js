// Planner Phase 2 live sync: join:planner / leave:planner (admin only, ack) and the planner:changed event.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io as ioClient } from "socket.io-client";
import { openSessions, newUid, scope, cleanup, BASE_URL, sessionFor } from "./_util.js";
import { MON, buildWorld, S, ops, place, revOf } from "./_editorUtil.js";

const s = scope(newUid());
const NIL = "00000000-0000-4000-8000-000000000000";
let sessions;
let api;
let w;
const sockets = [];

const connect = (cookie) =>
  new Promise((resolve, reject) => {
    const sock = ioClient(BASE_URL, { extraHeaders: { Cookie: cookie }, transports: ["websocket"], reconnection: false });
    sockets.push(sock);
    sock.once("connect", () => resolve(sock));
    sock.once("connect_error", reject);
  });
const emitAck = (sock, event, payload) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ack for ${event}`)), 5000);
    sock.emit(event, payload, (res) => {
      clearTimeout(t);
      resolve(res);
    });
  });
/** Resolves with the next planner:changed payload, or null after `ms`. */
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
const joinPlanner = (sock) => emitAck(sock, "join:planner", { version_id: w.versionId });

before(async () => {
  sessions = await openSessions();
  api = sessions.api;
  w = await buildWorld(api, s);
});
after(async () => {
  for (const sock of sockets) sock.close();
  await cleanup(s, sessions);
});

test("join:planner: non-admin refused, admin acked; bad and unknown version ids refused", async () => {
  const user = await connect(sessions.user.cookie);
  assert.deepEqual(await joinPlanner(user), { ok: false, error: "Not allowed" });
  const admin = await connect(sessions.admin.cookie);
  assert.deepEqual(await emitAck(admin, "join:planner", { version_id: "nope" }), { ok: false, error: "Invalid version id" });
  assert.deepEqual(await emitAck(admin, "join:planner", {}), { ok: false, error: "Invalid version id" });
  assert.deepEqual(await emitAck(admin, "join:planner", { version_id: NIL }), { ok: false, error: "Version not found" });
  assert.deepEqual(await joinPlanner(admin), { ok: true });
  assert.deepEqual(await joinPlanner(admin), { ok: true }, "joining twice is harmless");
  // a refused non-admin receives nothing
  const gotNothing = nextEvent(user, 800);
  await ops(w, [{ op: "lock", session_id: S(w, "X", "TH1") }]);
  assert.equal(await gotNothing, null);
  await ops(w, [{ op: "unlock", session_id: S(w, "X", "TH1") }]);
});

test("join cap: at most 20 distinct rooms per socket; refused joins do not use up the cap; leaving frees a slot", async () => {
  const admin = await connect(sessions.admin.cookie);
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(await emitAck(admin, "join:planner", { version_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }), { ok: false, error: "Version not found" });
  }
  const versions = [];
  for (let i = 0; i < 21; i++) {
    const t = await api("POST", "/terms", { academic_year: s.year(), half: "odd" });
    versions.push(t.body.version.id);
  }
  for (let i = 0; i < 20; i++) assert.deepEqual(await emitAck(admin, "join:planner", { version_id: versions[i] }), { ok: true }, `join ${i}`);
  assert.deepEqual(await emitAck(admin, "join:planner", { version_id: versions[20] }), { ok: false, error: "Too many joined rooms" });
  assert.deepEqual(await emitAck(admin, "join:planner", { version_id: versions[0] }), { ok: true }, "already joined stays ok");
  assert.deepEqual(await emitAck(admin, "leave:planner", { version_id: versions[0] }), { ok: true });
  assert.deepEqual(await emitAck(admin, "join:planner", { version_id: versions[20] }), { ok: true });
});

test("planner:changed after a successful op: rev, prev_rev, client_id, sessions; none after a rejected or no-op request; none after leave", async () => {
  const admin = await connect(sessions.admin.cookie);
  assert.deepEqual(await joinPlanner(admin), { ok: true });
  const th = S(w, "X", "TH1");

  const rev0 = await revOf(w.versionId);
  const waiting = nextEvent(admin);
  const r = await ops(w, [place(w, th, MON, 510)], "tab-42");
  assert.equal(r.status, 200);
  const ev = await waiting;
  assert.ok(ev, "event received");
  assert.deepEqual(Object.keys(ev).sort(), ["client_id", "prev_rev", "refetch", "rev", "sessions", "version_id"]);
  assert.equal(ev.version_id, w.versionId);
  assert.equal(ev.rev, rev0 + 1);
  assert.equal(ev.prev_rev, rev0);
  assert.equal(typeof ev.rev, "number");
  assert.equal(ev.client_id, "tab-42");
  assert.equal(ev.refetch, false);
  assert.deepEqual(ev.sessions, r.body.sessions);
  assert.equal(ev.sessions[0].id, th);
  assert.equal(ev.sessions[0].weekday, MON);

  // without a client_id the event carries null
  const w2 = nextEvent(admin);
  await ops(w, [{ op: "lock", session_id: th }]);
  const ev2 = await w2;
  assert.equal(ev2.client_id, null);
  assert.equal(ev2.prev_rev, rev0 + 1);
  assert.equal(ev2.rev, rev0 + 2);

  // rejected op (locked) -> no event, no rev change
  const none = nextEvent(admin, 800);
  const rej = await ops(w, [{ op: "unplace", session_id: th }]);
  assert.equal(rej.status, 409);
  assert.equal(await none, null);
  // no-op request -> no event
  const none2 = nextEvent(admin, 800);
  const noop = await ops(w, [{ op: "lock", session_id: th }]);
  assert.equal(noop.body.sessions.length, 0);
  assert.equal(await none2, null);
  assert.equal(await revOf(w.versionId), rev0 + 2);

  // leave: no more events
  assert.deepEqual(await emitAck(admin, "leave:planner", { version_id: w.versionId }), { ok: true });
  const after_ = nextEvent(admin, 800);
  await ops(w, [{ op: "unlock", session_id: th }]);
  assert.equal(await after_, null);
  assert.deepEqual(await emitAck(admin, "leave:planner", { version_id: "bad" }), { ok: false, error: "Invalid version id" });
  // and rejoining works
  assert.deepEqual(await joinPlanner(admin), { ok: true });
  const again = nextEvent(admin);
  await ops(w, [{ op: "lock", session_id: th }]);
  assert.ok(await again);
});

test("sync-sessions that adds sessions emits a refetch event (sessions null); an idempotent sync emits nothing", async () => {
  const admin = await connect(sessions.admin.cookie);
  assert.deepEqual(await joinPlanner(admin), { ok: true });
  const idem = nextEvent(admin, 800);
  const same = await api("POST", `/versions/${w.versionId}/sync-sessions`);
  assert.equal(same.body.added, 0);
  assert.equal(await idem, null);

  // offer the unused subject to division Y, then sync
  const rev0 = await revOf(w.versionId);
  const off = await api("POST", `/terms/${w.termId}/offerings`, { division_id: w.Y.id, subject_id: w.subj.TH3.id, faculty: [{ faculty_id: w.fac.B.id }] });
  assert.equal(off.status, 201);
  const waiting = nextEvent(admin);
  const sync = await api("POST", `/versions/${w.versionId}/sync-sessions`);
  assert.equal(sync.status, 200);
  assert.equal(sync.body.added, 1);
  assert.equal("prev_rev" in sync.body, false, "the existing sync response is unchanged");
  const ev = await waiting;
  assert.ok(ev, "refetch event received");
  assert.deepEqual(ev, { version_id: w.versionId, rev: rev0 + 1, prev_rev: rev0, client_id: null, sessions: null, refetch: true });
});

test("a socket without a session cookie cannot connect", async () => {
  await assert.rejects(
    new Promise((resolve, reject) => {
      const sock = ioClient(BASE_URL, { transports: ["websocket"], reconnection: false });
      sockets.push(sock);
      sock.once("connect", resolve);
      sock.once("connect_error", reject);
    })
  );
  assert.ok(sessionFor);
});
