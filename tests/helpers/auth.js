// tests/helpers/auth.js — shared by the integration suites.
//
// There is deliberately NO test bypass in the server (no "accept code 000000" flag).
// Tests instead write straight to the database the way the server itself does:
//   - sessionFor(): creates a real session row (same createSession() a sign-in calls)
//   - seedCode():   stores a code whose digits the test knows (the real code only
//                   ever exists encrypted inside the queued email job)
import "dotenv/config";
import pool from "../../database/db.js";
import { createSession, COOKIE_NAME } from "../../services/sessions.js";
import { hashCode } from "../../utils/otpCrypto.js";

export { COOKIE_NAME };

export const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

// A logged-in cookie ("name=value") for a profile id or email. A fresh login counts
// as a recent authentication, so step-up-protected routes accept it for 10 minutes.
export async function sessionFor(userIdOrEmail, opts = {}) {
  let id = userIdOrEmail;
  if (String(userIdOrEmail).includes("@")) {
    const { rows } = await pool.query("SELECT id FROM profiles WHERE email = $1", [userIdOrEmail]);
    if (!rows[0]) throw new Error(`no profile for ${userIdOrEmail}`);
    id = rows[0].id;
  }
  const { token, id: sessionId } = await createSession(id, { remember: true, ...opts });
  return { cookie: `${COOKIE_NAME}=${token}`, token, sessionId };
}

// Replaces the live code for email+purpose with one the test knows.
export async function seedCode(email, code, purpose = "login") {
  await pool.query(
    "UPDATE auth_codes SET consumed_at = NOW() WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL",
    [email, purpose]
  );
  const { rows } = await pool.query(
    `INSERT INTO auth_codes (email, purpose, code_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes') RETURNING id`,
    [email, purpose, hashCode(email, purpose, code)]
  );
  return rows[0].id;
}

// Same-origin JSON request (Origin = the API itself, which the CSRF check allows).
export async function http(method, path, { cookie, body, headers } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: BASE_URL,
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

export const sessionCookieFrom = (res) => {
  const c = res.headers.getSetCookie().find((x) => x.startsWith(`${COOKIE_NAME}=`));
  return c ?? null;
};

let counter = 0;
export const uniqEmail = (tag) =>
  `t-${tag}-${Date.now()}-${++counter}-${Math.floor(Math.random() * 1e6)}@mitwpu.edu.in`;
