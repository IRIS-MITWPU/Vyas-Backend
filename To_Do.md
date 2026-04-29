# To_Do.md — Backend Production Readiness Checklist
## Project: Vyas-Backend

> Updated on 30-04-2026.

---

## ~~ PHASE 1 — Foundation (Must exist before writing any features) ~~ Done
### 1.1 Project Structure & Conventions



- [ ] **Extract Redis into a shared module**
  - **Why:** `buildings.js`, `booking.js`, and `sockets/index.js` each create their own Redis connection. That's 3–4 separate TCP connections to Redis for one server process. As routes grow this will multiply. Each top-level `await redis.connect()` also means the module crashes at load time if Redis is unreachable.
  - **What:** Create `database/redis.js` that creates and exports a single Redis client. All files import from it.
  - **How:** Create `database/redis.js`:
    ```js
    import { createClient } from "redis";
    const redis = createClient({ url: process.env.REDIS_URL });
    await redis.connect();
    export default redis;
    ```
    Then in `buildings.js`, `booking.js`, remove their local `createClient` + `await redis.connect()` calls and replace with `import redis from "../database/redis.js"`.



- [ ] **Add startup validation for required env vars**
  - **Why:** If `JWT_SECRET`, `DATABASE_URL`, or `REDIS_URL` are missing, the server starts without error and only fails mid-request. This is confusing in production. A fast-fail at startup with a clear message is much better.
  - **What:** At the top of `app.js`, check all required env vars exist before mounting any routes.
  - **How:**
    ```js
    const REQUIRED_ENV = ["JWT_SECRET", "REDIS_URL", "DB_USER", "DB_PASSWORD", "DB_HOST", "DB_NAME"];
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length) {
      console.error("❌ Missing required env vars:", missing.join(", "));
      process.exit(1);
    }
    ```

### 1.2 Database Setup

- [ ] **Create and commit a schema migration SQL file**
  - **Why:** There are no migration files in this repo. The schema used in queries (`profiles`, `user_auth`, `buildings`, `floors`, `rooms`, `bookings`) must be created somewhere — currently it only exists in the developer's local DB. Anyone else setting up the project (or deploying to a new environment) will have no schema.
  - **What:** Create `database/schema.sql` with all `CREATE TABLE` statements matching what the code queries.
  - **How:** Cross-reference `Vyas-Faculty-Availability/supabase/migrations/` for the original Supabase schema. Adapt for this backend (adding `user_auth` table, ensuring `profiles` has the right columns). Add `database/schema.sql` to the repo.

- [ ] **Add the `user_auth` table to schema**
  - **Why:** This backend splits authentication from profiles — `profiles` holds user info, `user_auth` holds the password hash. This table doesn't exist in the Supabase schema and must be explicitly created.
  - **What:** `CREATE TABLE user_auth (user_id UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`
  - **How:** Add to `database/schema.sql`. Ensure the `profiles.id` column is UUID and matches the FK reference.

- [ ] **Seed the database with test data**
  - **Why:** Without sample data, every developer has to manually register users and create buildings/rooms through the API. Slows down development significantly.
  - **What:** Create `database/seed.js` with a few faculty users, one admin, sample buildings, floors, rooms.
  - **How:** Use the same `pg` pool and insert rows. Run with `node database/seed.js`. Guard with `NODE_ENV !== 'production'` check to prevent accidental seeding.

### 1.3 Server Setup

- [ ] **Add a proper `/health` endpoint**
  - **Why:** The current root `/` returns a plain string — not JSON, no status code, no DB check. Hosting platforms (Render, Railway, Fly.io) require a `/health` endpoint returning HTTP 200 JSON to confirm the app is alive. Without it, deployments fail or appear unhealthy.
  - **What:** `GET /health` → `{ status: "ok", timestamp: "...", db: "connected" }` with a lightweight DB ping.
  - **How:**
    ```js
    app.get("/health", async (req, res) => {
      try {
        await pool.query("SELECT 1");
        res.json({ status: "ok", timestamp: new Date().toISOString(), db: "connected" });
      } catch {
        res.status(503).json({ status: "error", db: "disconnected" });
      }
    });
    ```

- [ ] **Add global error handling middleware**
  - **Why:** Express v5 has improved async error propagation, but without a global error handler, unhandled errors either crash the process or leak stack traces to clients (a security risk).
  - **What:** A catch-all `(err, req, res, next)` middleware that logs errors server-side and returns a clean JSON response.
  - **How:** Add as the last middleware in `app.js`:
    ```js
    app.use((err, req, res, next) => {
      console.error(err);
      res.status(err.status || 500).json({ error: err.message || "Internal server error" });
    });
    ```

- [ ] **Add request logging (morgan)**
  - **Why:** Without request logs, debugging production issues is guesswork. You need to see which endpoints are being hit, with what status codes, and how long they take.
  - **What:** Log every request: method, path, status, response time.
  - **How:** `npm install morgan` → `import morgan from "morgan"` → `app.use(morgan("combined"))` in `app.js` before routes.

- [ ] **Clean up unused dependencies**
  - **Why:** `graphql` and `ioredis` are installed but never imported or used. Dead dependencies increase install time, attack surface, and confusion.
  - **What:** Remove `graphql` and `ioredis` from `package.json`.
  - **How:** `npm uninstall graphql ioredis` — verify nothing imports them first with `grep -r "graphql\|ioredis" --include="*.js" .`.

---

## ~~ PHASE 2 — Authentication (Already partially done — complete and harden) ~~ Done

- [ ] **Rename `middlewares/authMiddleware` → `middlewares/authMiddleware.js`**
  - **Why:** The file exists without a `.js` extension, which is non-standard for ES modules. Node resolves it on some systems but not reliably. Explicit extensions are required when using `"type": "module"`.
  - **What:** Rename the file and update all imports.
  - **How:** Rename file → update import in `routes/booking.js` and anywhere else it's imported.

- [ ] **Add `FRONTEND_ORIGIN` to `.env` and `.env.example`**
  - **Why:** `app.js` and `sockets/index.js` read `process.env.FRONTEND_ORIGIN` for CORS origin. It's not in `.env`, so in production it silently defaults to `http://localhost:3000` — meaning the deployed frontend on Vercel would be blocked by CORS.
  - **What:** Add `FRONTEND_ORIGIN=http://localhost:5173` (dev) and set `https://your-app.vercel.app` in production.
  - **How:** Add to `.env` and `.env.example`. In production hosting, set to the actual Vercel URL.

- [ ] **Add input validation to register and login**
  - **Why:** Currently `register` only checks email domain. It doesn't check: is `full_name` present, is `password` long enough, are fields the right types? Malformed input will throw confusing DB errors instead of clean 400 responses.
  - **What:** Validate: `full_name` required + non-empty, `email` required + valid format + `@mitwpu.edu.in` domain, `password` required + min 8 chars.
  - **How:** Install `zod`: `npm install zod`. Add a schema at the top of `userController.js`:
    ```js
    import { z } from "zod";
    const registerSchema = z.object({
      full_name: z.string().min(1),
      email: z.string().email().endsWith("@mitwpu.edu.in"),
      password: z.string().min(8),
    });
    ```
    Parse `req.body` with it; catch `ZodError` and return `400`.

- [ ] **Implement role-based access control (RBAC) middleware**
  - **Why:** `adminOnly` middleware exists but is not applied to any routes yet. Admin-only endpoints (view all bookings, manage buildings/rooms/users) need to be protected.
  - **What:** Apply `adminOnly` after `protect` on all admin routes once they are built.
  - **How:** `router.get('/admin/all', protect, adminOnly, handler)`. The middleware is already written in `middlewares/authMiddleware`.

- [ ] **Document and enforce JWT secret strength**
  - **Why:** A weak `JWT_SECRET` can be brute-forced, allowing an attacker to forge tokens and authenticate as any user.
  - **What:** Require `JWT_SECRET` to be at least 32 characters. Validate at startup.
  - **How:** Add to startup validation: `if (process.env.JWT_SECRET.length < 32) { console.error("JWT_SECRET must be at least 32 chars"); process.exit(1); }`. Generate a strong secret with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

- [ ] **Add password reset flow**
  - **Why:** Users will forget passwords. Without a reset mechanism, they're permanently locked out — requiring manual DB intervention. `nodemailer` is already installed.
  - **What:** `POST /user/forgot-password` → generate time-limited token, send reset email. `POST /user/reset-password` → verify token, update password hash.
  - **How:** Create a `password_reset_tokens` table: `(id UUID PK, user_id UUID FK, token TEXT, expires_at TIMESTAMPTZ)`. Use `nodemailer` + MIT WPU SMTP or a transactional service. Expire tokens after 1 hour.

---

## PHASE 3 — Core Features

- [ ] **Booking management endpoints**
  - **Why:** Currently only `POST /booking` (create) exists. The frontend needs to display a user's bookings, allow cancellation, and admins need to see all bookings.
  - **What:**
    - `GET /booking/my` — get authenticated user's bookings (upcoming + past)
    - `GET /booking/:id` — get a single booking's details
    - `DELETE /booking/:id` — cancel a booking (own bookings only; admin can cancel any)
    - `GET /booking/admin/all` — admin: get all bookings with filters (date, room, status)
  - **How:** All routes use `protect`. `DELETE` checks `req.user.id === booking.teacher_id || req.user.is_admin`. Admin route also needs `adminOnly`.

- [ ] **Building and room management endpoints (admin)**
  - **Why:** The frontend `AdminDashboard.tsx` has UI for creating/editing/deleting buildings, floors, and rooms. Without these endpoints, the admin panel can't function.
  - **What:**
    - `POST /building` — create building (admin only)
    - `PUT /building/:id` — update building (admin only)
    - `DELETE /building/:id` — delete building (admin only)
    - `POST /building/:id/floor` — create floor
    - `POST /floor/:id/room` — create room
    - `PUT /room/:id` — update room
    - `DELETE /room/:id` — delete room
  - **How:** All protected with `protect + adminOnly`. Use parameterized queries.

- [ ] **User management endpoints (admin)**
  - **Why:** The frontend admin dashboard allows toggling a user's admin status. Without this endpoint, admin management only works via direct DB.
  - **What:**
    - `GET /user/all` — list all users (admin only)
    - `PATCH /user/:id/admin` — toggle `is_admin` flag (admin only)
  - **How:** Protected with `protect + adminOnly`.

- [ ] **Timetable template endpoints**
  - **Why:** The frontend has full UI for recurring timetable templates (`room_timetable_templates`). Currently these are handled by Supabase Edge Functions. They need to be ported to this backend.
  - **What:**
    - `GET /room/:id/timetable` — get timetable templates for a room
    - `POST /room/:id/timetable` — create a timetable template (admin)
    - `PUT /timetable/:id` — update template (admin)
    - `DELETE /timetable/:id` — delete template (admin)
    - `POST /timetable/:id/exception` — create a template exception
  - **How:** These match the `room_timetable_templates` and `room_timetable_template_exceptions` tables from the Supabase schema.

- [ ] **Free room finder endpoint**
  - **Why:** The frontend has a `FreeRooms.tsx` component (currently commented out) that finds rooms available at a given date/time slot. This requires a query across rooms and bookings.
  - **What:** `GET /rooms/free?date=&startTime=&endTime=` — returns rooms not booked during the specified window.
  - **How:** Query rooms WHERE id NOT IN (SELECT room_id FROM bookings WHERE time range overlaps). Use `tstzrange` overlap operator as already used in booking conflict check.

- [ ] **Email notifications (nodemailer)**
  - **Why:** `nodemailer` is installed but completely unused. The Supabase frontend sends booking confirmation emails via an Edge Function. This should be ported to use this backend's `nodemailer`.
  - **What:** Send email on: booking created (to teacher + any invitees), booking cancelled, booking approved/denied.
  - **How:** Create `services/emailService.js`. Configure nodemailer with SMTP (MIT WPU SMTP or a transactional provider). Call from booking creation/cancellation handlers.

---

## PHASE 4 — Security Hardening

- [ ] **Rate limiting on auth endpoints**
  - **Why:** `/user/register` and `/user/login` are currently wide open to brute-force attacks. An attacker can try unlimited password combinations per second.
  - **What:** Limit: `/user/login` → 10 requests per 15 minutes per IP. `/user/register` → 5 requests per hour per IP. General API → 100 requests per minute.
  - **How:** `npm install express-rate-limit` → 
    ```js
    import rateLimit from "express-rate-limit";
    const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 10 });
    app.use("/user/login", authLimiter);
    app.use("/user/register", authLimiter);
    ```

- [ ] **Add Helmet (security headers)**
  - **Why:** Without HTTP security headers, browsers allow clickjacking, MIME type sniffing, and other attack vectors. One `npm install` + one line fixes most of them.
  - **What:** Set `X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy`, `Strict-Transport-Security`, etc.
  - **How:** `npm install helmet` → `import helmet from "helmet"` → `app.use(helmet())` as the first middleware in `app.js`.

- [ ] **Never log sensitive data**
  - **Why:** Passwords, tokens, and personal data must never appear in server logs. Log access (or a leaked log file) becomes a full credential breach.
  - **What:** Audit all `console.error` and logging calls. Never log `req.body` when it contains passwords. Never log raw JWTs.
  - **How:** Search `grep -r "console.log\|console.error" --include="*.js" .` and review each occurrence. In morgan, use the `"combined"` or `"short"` format (does not log body).

- [ ] **Store secrets only in env — audit for hardcoded values**
  - **Why:** If a secret is ever committed to Git, it is compromised permanently (Git history persists even after deletion).
  - **What:** Confirm no secrets, connection strings, or API keys appear anywhere in source code.
  - **How:** `grep -r "secret\|password\|key\|token\|redis://" --include="*.js" src/` and verify every match is reading from `process.env`, not a hardcoded value.

- [ ] **Validate and sanitize booking input**
  - **Why:** `POST /booking` currently only checks that `roomId`, `lockToken`, `title`, `startTime`, `endTime` exist. It doesn't validate: are times valid ISO strings, is `endTime` after `startTime`, are string fields within length limits?
  - **What:** Add `zod` schema validation for all booking fields.
  - **How:**
    ```js
    const bookingSchema = z.object({
      roomId: z.string().uuid(),
      lockToken: z.string().uuid(),
      title: z.string().min(1).max(255),
      startTime: z.string().datetime(),
      endTime: z.string().datetime(),
      ...
    }).refine(d => new Date(d.endTime) > new Date(d.startTime), "endTime must be after startTime");
    ```

---

## PHASE 5 — Code Quality

- [ ] **Write tests for auth and booking**
  - **Why:** Auth is the most security-critical part of the app. A broken login means no one can use the system. Without tests, every refactor risks silently breaking auth.
  - **What:** Test: register with valid data returns 201 + JWT cookie, register with invalid email domain returns 400, login with wrong password returns 401, `POST /booking` without auth returns 401, booking with valid lock succeeds.
  - **How:** `npm install -D jest supertest` (or use Node's built-in `node:test` + `supertest`). Create `tests/auth.test.js` and `tests/booking.test.js`. Use a test DB (separate `DB_NAME` in test env).

- [ ] **Add a `README.md`**
  - **Why:** There is no README. No one (including future you) knows how to set up or run the project without reading every file.
  - **What:** Cover: what the project is, prerequisites (Node 20+, PostgreSQL, Redis), setup steps, env vars, how to run locally, how to run tests, how to deploy.
  - **How:** Write `README.md` at the root of `Vyas-Backend/`. Test by following the steps yourself on a fresh terminal.

---

## PHASE 6 — Deployment Preparation

- [ ] **Choose and configure a hosting platform**
  - **Why:** The backend needs a persistent server — Vercel only hosts the frontend (SPA + serverless). This Express server with Socket.IO requires a persistent process.
  - **What:** Recommended: **Render** (free tier, easy GitHub integration, supports WebSockets). Alternative: Railway, Fly.io.
  - **How:** Connect GitHub repo to Render. Set all env vars in Render dashboard. Set Start Command to `npm start`. Add `render.yaml` for config-as-code.

- [ ] **Set up a hosted PostgreSQL + Redis**
  - **Why:** Local DB/Redis won't be accessible from a cloud server.
  - **What:** PostgreSQL → **Supabase** free tier (reuse existing project), Render Postgres, or Neon. Redis → **Upstash** (free tier, serverless Redis, gives `REDIS_URL`).
  - **How:** Get connection strings → set `DATABASE_URL` (or individual `DB_*` vars) and `REDIS_URL` in hosting platform env vars → run `psql $DATABASE_URL -f database/schema.sql` to apply schema.

- [ ] **Add a `Dockerfile`**
  - **Why:** Docker makes the app run identically across local, staging, and production. Required for Fly.io; useful everywhere.
  - **What:** Multi-stage build: install deps → copy source → start server.
  - **How:**
    ```dockerfile
    FROM node:20-alpine
    WORKDIR /app
    COPY package*.json ./
    RUN npm ci --omit=dev
    COPY . .
    EXPOSE 3000
    CMD ["node", "app.js"]
    ```

- [ ] **Set up CI/CD (GitHub Actions)**
  - **Why:** Manual deployments are error-prone. CI ensures tests pass before code reaches production.
  - **What:** `.github/workflows/ci.yml` — install deps, run linter, run tests. Auto-deploy to Render on `main` push if tests pass.
  - **How:** Use Render's GitHub Actions deploy hook. Add `RENDER_DEPLOY_HOOK_URL` as a GitHub secret.

---

## PHASE 7 — Monitoring & Reliability

- [ ] **Set up structured logging (pino or winston)**
  - **Why:** `console.log` output is hard to filter/search in production. Structured JSON logs can be queried by log tools (Datadog, Logtail, etc.).
  - **What:** Replace all `console.log/error` calls with a logger that outputs JSON with `{ level, timestamp, message, ...context }`.
  - **How:** `npm install pino pino-http` → configure log level via `LOG_LEVEL` env var.

- [ ] **Set up error tracking (Sentry)**
  - **Why:** When the app crashes in production, you need to know immediately — what error, which user, which endpoint, what the stack trace was. Especially critical for Socket.IO disconnect edge cases.
  - **What:** Sentry free tier catches all unhandled errors and sends alerts with full context.
  - **How:** `npm install @sentry/node` → `Sentry.init({ dsn: process.env.SENTRY_DSN })` → add Sentry error handler before global error middleware.

- [ ] **Add uptime monitoring**
  - **Why:** Without monitoring, a server going down at 2am goes unnoticed until users complain. With a `/health` endpoint, a free uptime monitor can alert you within minutes.
  - **What:** Set up a free monitor on UptimeRobot or BetterUptime pointing to `GET /health`.
  - **How:** Sign up → add your backend URL → set alert email. 5 minutes of work.

---

## 🔍 Project-Specific Issues Found

These are real bugs and gaps found by scanning the current codebase (as of 2026-04-28):

- [ ] **[CRITICAL] `routes/booking.js` import path is wrong** — `"../middleware/authMiddleware.js"` should be `"../middlewares/authMiddleware.js"`. Booking creation fails with module-not-found at startup.
- [ ] **[CRITICAL] `middlewares/authMiddleware` has no `.js` extension** — required for ES modules. Rename the file.
- [ ] **[HIGH] `FRONTEND_ORIGIN` not in `.env`** — CORS will use localhost fallback in production, blocking the Vercel frontend.
- [ ] **[HIGH] No `.env.example`** — impossible to onboard new devs or set up CI without guessing env var names.
- [ ] **[HIGH] 3 separate Redis clients created** — extract to `database/redis.js` and share.
- [ ] **[MEDIUM] `graphql` and `ioredis` installed but unused** — remove from `package.json`.
- [ ] **[MEDIUM] No startup env var validation** — missing vars cause mid-request failures, not a clean startup error.
- [ ] **[MEDIUM] Top-level `await redis.connect()` in route files** — if Redis is unavailable at startup, the entire module load fails with a cryptic error.
- [ ] **[MEDIUM] No schema migration files** — schema exists only in the developer's local DB. Deploying to any new environment requires manual DB setup.
- [ ] **[LOW] `register` and `login` lack input validation** — beyond email domain check, no field validation exists.

---

## ✅ MVP Sign-off Criteria

Before this backend is called "production-ready," all of the following must be true:

- [ ] Critical import path bug fixed — server starts without errors
- [ ] `.env.example` exists with all required vars documented
- [ ] `/health` endpoint returns `200 OK` JSON
- [ ] `POST /user/register` and `POST /user/login` work end-to-end with real DB
- [ ] `POST /booking` works end-to-end: lock → create booking → Socket.IO notification
- [ ] CORS configured to allow the Vercel frontend domain
- [ ] Rate limiting on auth endpoints
- [ ] Helmet middleware added
- [ ] No hardcoded secrets in source code
- [ ] Database schema file committed to repo
- [ ] At least 5 passing tests covering auth and booking
- [ ] Env vars configured in hosting platform (nothing hardcoded)
- [ ] Server deployed and `/health` returns 200 from the public URL
- [ ] Socket.IO connects from the deployed frontend
- [ ] At least one real end-to-end test: frontend calls backend, booking persists in DB
