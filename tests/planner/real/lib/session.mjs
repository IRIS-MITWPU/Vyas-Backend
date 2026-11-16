// Admin session for the CLI scripts. The ONLY place that touches the database (through tests/helpers/auth.js, exactly like the
// API tests do): it mints a real session row for the admin and removes it again. Set PLANNER_COOKIE="name=value" to skip the DB entirely.
// Run the scripts from Vyas-Backend so dotenv finds .env. Never prints the cookie.
export const ADMIN_EMAIL = 'admin@mitwpu.edu.in';

export async function openAdminSession(email = ADMIN_EMAIL) {
  const baseUrl = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  if (process.env.PLANNER_COOKIE) {
    return { baseUrl, cookie: process.env.PLANNER_COOKIE, async release() {}, pool: null };
  }
  const { sessionFor } = await import('../../../helpers/auth.js');
  const { default: pool } = await import('../../../../database/db.js');
  const s = await sessionFor(email);
  return {
    baseUrl: (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    cookie: s.cookie,
    pool,
    async release() {
      try {
        await pool.query('DELETE FROM sessions WHERE id = $1', [s.sessionId]);
      } finally {
        await pool.end();
      }
    },
  };
}
