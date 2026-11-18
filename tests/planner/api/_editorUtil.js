// Shared scenario builder for the Phase 2 editor tests (not a test file: the glob is *.test.js).
//
// buildWorld() creates, through the real API, one term with
//   faculty A B C D E F, rooms (3 classrooms + 2 labs from the real room list, all seating >= 24),
//   subjects  TH1 (theory 60 min, 2/week)  TH2 (theory 60 min, 1/week)  LB (lab 120 min, 1/week)  TH3 (theory, not offered)
//   division X (sem 3, 24 students, batches X1 X2 X3 with 8 each):
//       TH1 <- A, TH2 <- B, LB <- X1: C (lead) + E (assist), X2: D, X3: F
//   division Y (sem 3, 24 students, no batches, home room = first classroom):
//       TH1 <- A, TH2 <- E
// and syncs the sessions: X has TH1#1 TH1#2 TH2#1 on the whole batch and LB#1 on X1, X2, X3; Y has TH1#1 TH1#2 TH2#1.
// Grid facts (default term): 08:30 = 510 ... 17:45 = 1065, breaks 630-645, 765-810, 930-945.
import { pool, makeTerm, makeFaculty } from "./_util.js";

export const MON = 0;
export const TUE = 1;
export const WED = 2;

export async function poolRoomIds() {
  const { rows: c } = await pool.query(
    "SELECT id FROM rooms WHERE is_active AND room_type = 'classroom' AND capacity >= 24 ORDER BY name LIMIT 3"
  );
  const { rows: l } = await pool.query(
    "SELECT id FROM rooms WHERE is_active AND room_type = 'lab' AND capacity >= 24 ORDER BY name LIMIT 2"
  );
  const { rows: other } = await pool.query(
    "SELECT id FROM rooms WHERE is_active AND room_type = 'classroom' AND capacity >= 24 ORDER BY name OFFSET 3 LIMIT 1"
  );
  return { classrooms: c.map((r) => r.id), labs: l.map((r) => r.id), outside: other[0].id };
}

export const roomName = async (id) => (await pool.query("SELECT name FROM rooms WHERE id = $1", [id])).rows[0].name;

export async function buildWorld(api, s, { termExtra = {}, tag = "" } = {}) {
  const term = await makeTerm(api, s, termExtra);
  const fac = {};
  for (const n of ["A", "B", "C", "D", "E", "F"]) fac[n] = await makeFaculty(api, s, `${tag}${n}`);
  const rooms = await poolRoomIds();
  const add = await api("POST", `/terms/${term.id}/rooms`, { room_ids: [...rooms.classrooms, ...rooms.labs] });
  if (add.status !== 201) throw new Error(`rooms: ${JSON.stringify(add.body)}`);

  const mk = async (body) => {
    const r = await api("POST", `/terms/${term.id}/subjects`, body);
    if (r.status !== 201) throw new Error(`subject: ${JSON.stringify(r.body)}`);
    return r.body.subject;
  };
  const subj = {
    TH1: await mk({ code: "TH1", name: "Theory One", kind: "theory", weekly_count: 2 }),
    TH2: await mk({ code: "TH2", name: "Theory Two", kind: "theory", weekly_count: 1 }),
    LB: await mk({ code: "LB", name: "Lab", kind: "lab", weekly_count: 1 }),
    TH3: await mk({ code: "TH3", name: "Theory Three", kind: "theory", weekly_count: 1 }),
  };
  const dx = await api("POST", `/terms/${term.id}/divisions`, {
    semester: 3, name: "X", student_count: 24,
    batches: [{ name: "X1", student_count: 8 }, { name: "X2", student_count: 8 }, { name: "X3", student_count: 8 }],
  });
  const dy = await api("POST", `/terms/${term.id}/divisions`, { semester: 3, name: "Y", student_count: 24 }); // no home room: the editor tests place Y anywhere (home rooms are tested in building_homerooms.test.js)
  if (dx.status !== 201 || dy.status !== 201) throw new Error(`divisions: ${JSON.stringify([dx.body, dy.body])}`);
  const X = dx.body.division;
  const Y = dy.body.division;
  const bx = Object.fromEntries(X.batches.map((b) => [b.name, b]));

  const off = async (division, subject, faculty) => {
    const r = await api("POST", `/terms/${term.id}/offerings`, { division_id: division.id, subject_id: subject.id, faculty });
    if (r.status !== 201) throw new Error(`offering: ${JSON.stringify(r.body)}`);
    return r.body.offering;
  };
  await off(X, subj.TH1, [{ faculty_id: fac.A.id }]);
  await off(X, subj.TH2, [{ faculty_id: fac.B.id }]);
  await off(X, subj.LB, [
    { faculty_id: fac.C.id, batch_id: bx.X1.id }, { faculty_id: fac.E.id, batch_id: bx.X1.id, role: "assist" },
    { faculty_id: fac.D.id, batch_id: bx.X2.id }, { faculty_id: fac.F.id, batch_id: bx.X3.id },
  ]);
  await off(Y, subj.TH1, [{ faculty_id: fac.A.id }]);
  await off(Y, subj.TH2, [{ faculty_id: fac.E.id }]);

  const sync = await api("POST", `/versions/${term.versionId}/sync-sessions`);
  if (sync.status !== 200 || sync.body.added !== 9) throw new Error(`sync: ${JSON.stringify(sync.body)}`);
  const w = { tag, term, termId: term.id, versionId: term.versionId, fac, rooms, subj, X, Y, bx, api, sessions: new Map() };
  await refreshSessions(w);
  return w;
}

/** Re-reads the version's sessions and indexes them; use S(w, 'X', 'TH1', 'ALL', 1) to find one. */
export async function refreshSessions(w) {
  const out = new Map();
  for (const d of [w.X, w.Y]) {
    const r = await w.api("GET", `/versions/${w.versionId}/sessions?division_id=${d.id}`);
    for (const x of r.body.sessions) out.set(`${d.name}/${x.subject_code}/${x.batch_name}/${x.seq}`, x);
  }
  w.sessions = out;
}

/** S(w,'X','TH1','ALL',1) -> session id.  Batch 'ALL' = whole division. */
export function S(w, div, code, batch = "ALL", seq = 1) {
  const x = w.sessions.get(`${div}/${code}/${batch}/${seq}`);
  if (!x) throw new Error(`no session ${div}/${code}/${batch}/${seq}`);
  return x.id;
}

export const ops = (w, list, client_id) => w.api("POST", `/versions/${w.versionId}/ops`, { ops: list, ...(client_id ? { client_id } : {}) });
export const place = (w, session_id, weekday, start_min, room_id) => ({ op: "place", session_id, weekday, start_min, ...(room_id ? { room_id } : {}) });

export const revOf = async (versionId) => Number((await pool.query("SELECT rev FROM planner_versions WHERE id = $1", [versionId])).rows[0].rev);
export const occCount = async (versionId, where = "TRUE", params = []) =>
  (await pool.query(`SELECT count(*)::int AS n FROM planner_occupancy WHERE version_id = $1 AND ${where}`, [versionId, ...params])).rows[0].n;
export const occOf = async (sessionId) =>
  (await pool.query(
    "SELECT kind, resource_id, weekday, lower(during) AS start_min, upper(during) AS end_min FROM planner_occupancy WHERE session_id = $1 ORDER BY kind, resource_id",
    [sessionId]
  )).rows;
export const dbSession = async (id) =>
  (await pool.query("SELECT weekday, start_min, end_min, room_id, locked FROM planner_sessions WHERE id = $1", [id])).rows[0];

/** Back to a clean slate between tests that share a world: everything unplaced and unlocked, no occupancy, rev kept. */
export async function resetWorld(w) {
  await pool.query("DELETE FROM planner_occupancy WHERE version_id = $1", [w.versionId]);
  await pool.query(
    "UPDATE planner_sessions SET weekday = NULL, start_min = NULL, end_min = NULL, room_id = NULL, locked = false WHERE version_id = $1",
    [w.versionId]
  );
  await pool.query("UPDATE planner_versions SET status = 'draft' WHERE id = $1", [w.versionId]);
}

/** Every occupancy row must belong to a placed session and none may exist for unplaced sessions. */
export async function occupancyIsConsistent(versionId) {
  const { rows: [r] } = await pool.query(
    `SELECT count(*) FILTER (WHERE s.weekday IS NULL)::int AS orphan,
            (SELECT count(*)::int FROM planner_sessions p WHERE p.version_id = $1 AND p.weekday IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM planner_occupancy o WHERE o.session_id = p.id AND o.kind IN ('room', 'lab_room'))) AS missing_room
       FROM planner_occupancy o JOIN planner_sessions s ON s.id = o.session_id WHERE o.version_id = $1`,
    [versionId]
  );
  return r.orphan === 0 && r.missing_room === 0;
}
