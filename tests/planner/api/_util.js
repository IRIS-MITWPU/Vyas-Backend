// Shared helpers for the planner API integration tests (not a test file: the glob is *.test.js).
//
// The tests talk to a REAL running server (BASE_URL, default http://localhost:3000) started with
//   RUN_WORKERS=false PLANNER_ENABLED=true
// and the real local database. Everything they create is prefixed (terms: academic_year
// "zz_planner_test_<uid>…", faculty: short_code "ZZT<uid>…") and removed in cleanup().
import "dotenv/config";
import IORedis from "ioredis";
import pool from "../../../database/db.js";
import { BASE_URL, http, sessionFor } from "../../helpers/auth.js";

export { BASE_URL, http, sessionFor, pool };

export const ADMIN_EMAIL = "admin@mitwpu.edu.in";
export const NON_ADMIN_EMAIL = "ankit.desai@mitwpu.edu.in";

// Short per-file id: files run in parallel against one DB, so every file scopes its rows by its own uid.
export const newUid = () => Math.random().toString(36).slice(2, 8);

// The server's baseline limiter is 200 requests / 15 min / IP and the planner suite makes more than that.
// Clear the rate-limit keys (same thing `npm run test:reset` does) every few dozen requests. Dev/test only.
let redis;
let sinceFlush = 0;
async function flushRateLimits() {
  redis ??= new IORedis(process.env.REDIS_URL);
  for await (const keys of redis.scanStream({ match: "rl:*", count: 500 })) {
    if (keys.length) await redis.del(...keys);
  }
}

/** Returns api(method, path, body?) bound to one session cookie; paths are relative to /planner. */
export function plannerApi(cookie) {
  return async function api(method, path, body, opts = {}) {
    if (++sinceFlush >= 40) {
      sinceFlush = 0;
      await flushRateLimits();
    }
    return http(method, `/planner${path}`, { cookie, body, ...opts });
  };
}

/** Admin + non-admin sessions. Call release() in after(). */
export async function openSessions() {
  const admin = await sessionFor(ADMIN_EMAIL);
  const user = await sessionFor(NON_ADMIN_EMAIL);
  return {
    admin,
    user,
    api: plannerApi(admin.cookie),
    userApi: plannerApi(user.cookie),
    async release() {
      await pool.query("DELETE FROM sessions WHERE id = ANY($1::uuid[])", [[admin.sessionId, user.sessionId]]);
    },
  };
}

export function scope(uid) {
  let n = 0;
  return {
    uid,
    year: () => `zz_planner_test_${uid}_${++n}`,
    code: (name) => `ZZT${uid}${name}`,
    prefixYear: `zz_planner_test_${uid}`,
    prefixCode: `ZZT${uid}`,
  };
}

/** Removes everything a test file created, then closes shared connections. */
export async function cleanup(s, sessions) {
  await pool.query("DELETE FROM planner_terms WHERE academic_year LIKE $1", [`${s.prefixYear}%`]);
  await pool.query("DELETE FROM planner_faculty WHERE short_code LIKE $1", [`${s.prefixCode}%`]);
  if (sessions) await sessions.release();
  await redis?.quit();
  await pool.end();
}

export async function makeTerm(api, s, extra = {}) {
  const res = await api("POST", "/terms", { academic_year: s.year(), half: "odd", ...extra });
  if (res.status !== 201) throw new Error(`term create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { term: res.body.term, version: res.body.version, id: res.body.term.id, versionId: res.body.version.id };
}

export async function makeFaculty(api, s, name, extra = {}) {
  const res = await api("POST", "/faculty", { short_code: s.code(name), full_name: `Test ${name}`, ...extra });
  if (res.status !== 201) throw new Error(`faculty create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.faculty;
}

/** An existing room id (read-only use). */
export async function someRooms(n = 2, { lab = false } = {}) {
  const { rows } = await pool.query(
    "SELECT id FROM rooms WHERE is_active AND (room_type = 'lab') = $1 ORDER BY name LIMIT $2",
    [lab, n]
  );
  return rows.map((r) => r.id);
}

/** Simulates a placement on the first session of a version with a direct UPDATE (Phase 2 will do this via the engine). */
export async function placeOneSession(versionId, roomId, whereSql = "TRUE") {
  const { rows } = await pool.query(
    `UPDATE planner_sessions SET weekday = 0, start_min = 510, end_min = 570, room_id = $2
      WHERE id = (SELECT id FROM planner_sessions WHERE version_id = $1 AND ${whereSql} ORDER BY seq, id LIMIT 1)
      RETURNING id, offering_id, batch_id`,
    [versionId, roomId]
  );
  return rows[0];
}

export const fieldErrorsOf = (res) => res.body?.details?.fieldErrors ?? {};
