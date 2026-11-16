# Timetable Planner (backend)

Admin-only module for building a department's weekly timetable. **Phase 1 (this code)** covers academic setup, CSV/XLSX import, a readiness report and session generation. Nothing is placed on a grid yet: there is no editor, no clash engine, no publish step (see [Not built yet](#not-built-yet--carry-forward)).

What Phase 1 lets an admin do:

1. Create a **term** (academic year + odd/even half + branch, dates, working days, day hours, breaks).
2. Maintain **faculty** (global), **subjects**, **divisions and batches**, **offerings** (which subject a division studies and who teaches it) and the term's **room pool**, by hand or by import.
3. Run the **readiness report** (plain-English errors, warnings and notes about the data).
4. **Generate sessions**: expand offerings into one unplaced session per required class, ready for the Phase 2 editor.

Related docs (outside this repo, in the parent `VY/` folder): `PLANNER_CONTRACT.md` (the original shared contract), `PLANNER_LOG.md` (change log and carry-forward list). The frontend half is documented in `Vyas-Faculty-Availability/PLANNER.md`.

## Folder map

```
routes/planner/                 Thin Express routers (one file per resource) + index.js
  index.js                      Feature-flag gate, protect + adminOnly, mounts the rest, error handler
  terms.js faculty.js subjects.js divisions.js offerings.js rooms.js import.js sessions.js readiness.js
  respond.js                    ok(res, body, status) -> { success: true, ...body }
services/planner/               Use cases: validate input (zod), run SQL, return plain objects
  tx.js  validate.js  errors.js  guards.js  state.js
  terms.js faculty.js subjects.js divisions.js offerings.js rooms.js importer.js sessions.js readiness.js
services/planner/domain/        PURE functions. No DB, no I/O, no Express.
  termDefaults.js               DEFAULT_TERM_SETTINGS, teachable minutes per day, term weeks, default durations
  ruleDefaults.js               DEFAULT_RULES (19 rule keys seeded per term, not evaluated yet)
  importSpec.js                 Column specs, templates, per-entity row validation/normalisation
  limits.js                     LIMITS / INT4_MAX: field length and numeric limits shared by the API zod schemas and the import
  readiness.js                  computeReadiness(state) and the individual checks
  sessionSync.js                expectedSessions(state), planSessionSync({expected, existing})
  roomShare.js                  Phase 2: isShareable, fitsInRoom, peakLoad (lab rooms shared by capacity)
  index.js                      Barrel export
database/migrations/015_planner_core.sql   13 planner_* tables (same DDL is in database/schema.sql, between
                                           -- BEGIN PLANNER DDL / -- END PLANNER DDL markers)
tests/planner/
  unit/                         Domain tests (node:test, no server, no DB)
  sql/                          Schema tests against the real local DB (each test rolls back)
  api/                          HTTP tests against a RUNNING server and the real local DB
  fixtures/                     buildSemesterState(), semesterFixture.js, generateCsv.js and the 4 sample CSVs
```

`app.js` has two planner parts: `/planner`-scoped JSON parsers placed before the global parser (and before the flag gate, limiter and auth), and `app.use("/planner", plannerRoutes)`. The parser is chosen by path: **2 MB only for `POST /planner/terms/:id/import/:entity`** (imports are parsed in the browser and posted as JSON rows), **100 KB for every other planner route**. An oversized body is a body-parser error with status 413, answered by the app's global error handler like anywhere else.

## Naming and wire conventions

- Tables are prefixed `planner_`. IDs are `uuid` (`gen_random_uuid()`), timestamps `timestamptz`. Enumerations are `TEXT` + `CHECK` (not Postgres enums) so migrations stay idempotent.
- **Weekday is 0 = Monday ... 6 = Sunday** (same as `room_timetable_templates.weekday`).
- **Times are integer minutes since midnight** (`*_min`; 08:30 = 510). The grid is 15 minutes and is hard-wired in SQL (`start_min % 15 = 0`).
- JSON keys are `snake_case` in both directions. Dates are `YYYY-MM-DD` strings.
- Success: `{ "success": true, ... }`. Failure: `{ "success": false, "error": "<human message>", "code": "<CODE>", "details"?: ... }`.
- Error codes the planner raises:

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 (409 for "only a draft can be synced") | Bad input; `details.fieldErrors` is `{ field: [messages] }` |
| `NOT_FOUND` | 404 | Unknown id, malformed uuid in a path, or unknown route under `/planner` |
| `DUPLICATE` | 409 | Unique violation (term year/half/branch, faculty short code, names...) |
| `IN_USE` | 409 | Delete blocked because something references the row |
| `HAS_PLACED_SESSIONS` | 409 | Delete blocked because a session of it is already placed on the grid |
| `LOCKED_BY_PLACEMENTS` | 409 | Changing grid-defining term settings while sessions are placed |
| `CONFLICT_RETRY` | 409 | The request lost a race: Postgres deadlock (40P01), serialization failure (40001) or a row lock that stayed busy past `lock_timeout` (55P03; editor ops wait at most 10 s). Message: "The timetable changed at the same time. Please try again." Safe to retry. (Not in the contract's code list yet.) |
| `IMPORT_HAS_ERRORS` | 422 | A real (non dry-run) import had at least one error row; nothing was applied |
| `INTERNAL_ERROR` | 500 | Anything unexpected; Postgres error text never reaches the client |

- Auth failures come from the existing middleware (401/403, `REAUTH_REQUIRED` 403) and use that middleware's `{ error }` body, without `success:false`.

## How the pieces fit

```
HTTP -> routes/planner/*.js  -> services/planner/*.js  -> services/planner/domain/*.js
        (parse, call, reply)    (zod, SQL, transactions)   (pure rules and calculations)
```

- **Routes are thin.** They pick the service function, return `ok(res, ...)`, and write audit events where the contract asks for them. All routes use `protect, adminOnly`; `DELETE /planner/terms/:id` also uses `requireFreshAuth`.
- **Services own I/O.** They validate bodies with zod (`validate.js`), run raw `pg` queries, use `withTransaction` (`tx.js`) for multi-statement writes, and throw `PlannerError` (`errors.js`). The router's own error handler turns that into the response shape above, and maps stray Postgres errors (23505 -> `DUPLICATE`, 23503 -> `IN_USE`, ...) to generic messages.
- **The domain layer is pure.** Services load rows from the DB into a plain `state` object (`state.js`) and hand it to domain functions: `computeReadiness(state)`, `validateImportRows(entity, rows, ctx)`, `expectedSessions(state)` / `planSessionSync(...)`. Domain code never imports `pg`, never reads env, never throws on bad input. This is deliberate: the future solver (auto-scheduler) and the Phase 2 clash/rule engine must run the same rules against in-memory candidate timetables thousands of times, without a database. Keep new rules, expansion logic and calculations in `domain/` and cover them with `tests/planner/unit`.
- **Why `state` is passed in rather than fetched**: the same `computeReadiness` works for the HTTP report, the unit tests (via `buildSemesterState()`), and later the solver.

## Feature flag: `PLANNER_ENABLED`

Read on every request (not at boot). Anything other than the exact string `true` makes the whole `/planner` router answer `404 {"success":false,"error":"Not found"}` *before* auth, so the module looks like it does not exist. `.env.example` ships with `PLANNER_ENABLED=false`. The frontend has a matching `VITE_PLANNER_ENABLED`; keep them in sync.

## Running locally

Prerequisites: PostgreSQL (the local DB), Redis, and a `.env` (copy `.env.example`). **Check `DB_HOST=localhost` before any DB command.** Never run `npm run seed` against a database you care about.

1. Apply the migration (idempotent; safe to run twice): `npm run db:migrate`. A fresh DB gets `schema.sql` and then every migration.
2. Start a server for the planner (workers are not needed):

   ```bash
   # bash
   RUN_WORKERS=false PLANNER_ENABLED=true PORT=3100 node app.js
   ```
   ```powershell
   # PowerShell
   $env:RUN_WORKERS='false'; $env:PLANNER_ENABLED='true'; $env:PORT='3100'; node app.js
   ```

   `RUN_WORKERS=false` stops the email and import workers from starting in the API process. Use a spare port (3100 here) if your normal dev server already holds 3000. For the frontend to talk to it, its origin must be allowed (`FRONTEND_ORIGIN`, plus `localhost:5173` and `localhost:8080` outside production; see `config/origins.js`).
3. Run all planner tests (unit + SQL + API) against that server:

   ```bash
   BASE_URL=http://localhost:3100 npm run test:planner
   ```
   ```powershell
   $env:BASE_URL='http://localhost:3100'; npm run test:planner
   ```

   `BASE_URL` defaults to `http://localhost:3000`. Unit tests need neither server nor DB: `node --test "tests/planner/unit/*.test.js"`.
4. Individual suites (the globs **must be quoted** on Windows with Node 22; a bare directory fails with `MODULE_NOT_FOUND`):

   ```bash
   node --test "tests/planner/unit/*.test.js"
   node --test "tests/planner/sql/*.test.js"
   BASE_URL=http://localhost:3100 node --test "tests/planner/api/*.test.js"
   ```

What the tests touch (read before running against a DB you care about):

- API tests create rows prefixed `zz_planner_test_` / `ZZT...` and delete them afterwards; SQL tests roll back. They link test faculty to existing `profiles` by email (read-only).
- API tests **flush Redis `rl:*` keys** every few dozen requests (the global limiter is 200 requests / 15 min / IP and the suite exceeds it). Dev/test only, but it clears real rate-limit counters in whatever Redis `REDIS_URL` points at.
- They **leave `audit_events` rows** behind (`planner.term.create`, `planner.term.delete`, `planner.import.apply`, `planner.sessions.sync`).
- `flag.test.js` spawns its own flag-off server on port 3199.
- They sign in by writing a session row directly (`tests/helpers/auth.js`), with the admin `<admin email>` and the non-admin `<non-admin email>` from the local DB.

Current baseline: 391 tests pass (244 unit + 35 SQL + 112 API). The SQL tests count only their own fixture term's occupancy rows, so planner data in other terms (for example a placed real-data term) does not break them.

## API

All paths are under `/planner`, all need a signed-in admin. Response bodies are `{ success: true, ... }` with the keys shown.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Module liveness and the calling user |
| GET | `/terms` | List terms (`terms[]`, each with `counts` {divisions, subjects, offerings, rooms, sessions} and `draft_version_id`) |
| POST | `/terms` | Create a term; also creates draft version 1 and the default rule config in one transaction (201 `term`, `version`) |
| GET | `/terms/:id` | One term with its `versions` and `draft_version_id` |
| PATCH | `/terms/:id` | Partial update; grid-defining fields are `LOCKED_BY_PLACEMENTS` once any session is placed |
| DELETE | `/terms/:id` | Delete a term and everything under it (fresh auth required; faculty is untouched) |
| GET | `/available-rooms` | All active Vyas rooms, for the room-pool picker |
| GET | `/import-templates` | Column specs and sample rows for the four import entities |
| GET | `/faculty?term_id=` | Global faculty, with `linked_profile` and `assigned_in_term` (when `term_id` is given) |
| POST | `/faculty` | Create faculty (auto-links `profile_id` when `email` matches a profile) |
| PATCH | `/faculty/:id` | Partial update |
| DELETE | `/faculty/:id` | Delete; `IN_USE` ("assigned to offerings or generated sessions") if any offering or generated session references them |
| GET / POST | `/terms/:id/subjects` | List / create subjects (`duration_min` defaults from the term by kind) |
| PATCH / DELETE | `/terms/:id/subjects/:sid` | Update (`duration_min` and `kind` are `LOCKED_BY_PLACEMENTS` while a session of the subject is placed) / delete (`IN_USE` if it has offerings) |
| GET / POST | `/terms/:id/divisions` | List divisions with `batches[]` (whole batch included, `is_whole: true`) / create (also creates the whole batch) |
| PATCH / DELETE | `/terms/:id/divisions/:did` | Update (`student_count` is `LOCKED_BY_PLACEMENTS` while a placed whole-division lab session sits in a shared lab room) / delete (removes its unplaced sessions, bumps the draft `rev`; `HAS_PLACED_SESSIONS` if any is placed) |
| POST | `/terms/:id/divisions/:did/batches` | Add a batch |
| PATCH / DELETE | `/terms/:id/divisions/:did/batches/:bid` | Update (`student_count` is `LOCKED_BY_PLACEMENTS` while one of the batch's placed lab sessions sits in a shared lab room) / delete a batch (also removes its unplaced sessions and its `batch` occupancy rows, bumps the draft `rev`; the whole batch `ALL` is reserved: not editable or deletable) |
| GET / POST | `/terms/:id/offerings` | List (`?division_id=`) / create offerings, with their faculty |
| PATCH / DELETE | `/terms/:id/offerings/:oid` | Update `weekly_count` / `per_batch`; delete (removes unplaced sessions, bumps the draft `rev`; `HAS_PLACED_SESSIONS`) |
| PUT | `/terms/:id/offerings/:oid/faculty` | Replace the offering's whole faculty set |
| GET / POST | `/terms/:id/rooms` | List / add rooms to the term's pool (`{room_id, is_lab?}` or `{room_ids: [...]}`) |
| PATCH / DELETE | `/terms/:id/rooms/:rid` | Change `is_lab` (`LOCKED_BY_PLACEMENTS` to flip it while a placed session uses the room) / remove (`IN_USE` if sessions are placed in it) |
| POST | `/terms/:id/import/:entity?dryRun=true\|false` | Validate or apply an import; `entity` is `faculty`, `subjects`, `divisions` or `offerings` |
| GET | `/terms/:id/readiness` | Readiness report |
| POST | `/versions/:id/sync-sessions` | Generate / reconcile sessions for a draft version |
| GET | `/versions/:id/sessions/summary` | Per-division required / placed / unplaced counts and the version `rev` |
| GET | `/versions/:id/sessions?division_id=` | Session rows with subject, batch and faculty info |

Notes:

- `dryRun` must be exactly `true` or `false`.
- A real import is one transaction; with any error row it returns 422 `IMPORT_HAS_ERRORS` and applies nothing. The 422 body repeats the result (`summary`, `rows`) at the top level and inside `details`, because the frontend client only exposes `details`.
- Import body: `{ "rows": [ {...}, ... ] }`, at most 2000 rows. Response: `{ success, dry_run, applied, summary: {total, create, update, error}, rows: [{ row, status, errors, warnings, key }] }` (`row` is 1-based).
- Audit events are written for term create/delete, applied imports and session sync.

## Readiness report

`GET /planner/terms/:id/readiness` returns `{ success, ready, counts: {errors, warnings, info}, errors, warnings, info, stats }`. `ready` is true when there are no errors. Each issue is `{ code, severity, message, entity: {type, id, tab}, meta? }`; `entity.tab` (`settings|faculty|subjects|divisions|offerings|rooms`) is what the frontend uses for its "Fix" deep link (room issues use the term-room row id as `entity.id`). `stats` has `divisions, subjects, faculty_assigned, offerings, rooms, lab_rooms, sessions_required, teachable_minutes_per_day, term_weeks`.

Teachable minutes per day = (day end - day start) minus the breaks that lie inside the day. Term weeks = `ceil((end_date - start_date + 1) / 7)` and needs both dates.

| Code | Severity | Raised when |
|---|---|---|
| `OFFERING_NO_FACULTY` | error | An offering (or one of its batches) has no faculty |
| `NO_DIVISIONS` | error | The term has no divisions at all (an empty term is never ready) |
| `DIVISION_NO_OFFERINGS` | error | A division has no subjects assigned |
| `SUBJECT_UNUSED` | warning | A subject is not offered in any division |
| `NO_ROOMS_IN_POOL` | error | The term's room pool is empty |
| `NO_LAB_ROOM` | error | Lab offerings exist but the pool has no lab room |
| `NO_CLASSROOM_ROOM` | warning | Theory offerings exist but the pool has no non-lab room |
| `LAB_ROOMS_INSUFFICIENT` | warning | Fewer lab rooms than the largest number of non-whole batches in a division with labs |
| `ROOM_TOO_SMALL` | warning | No pool room of the right kind fits a division/batch |
| `ROOM_CAPACITY_UNKNOWN` | info | A pool room has no capacity recorded |
| `HOME_ROOM_NOT_IN_POOL` | warning | A division's home room is not in the pool |
| `FACULTY_WEEKLY_OVERLOAD` | error | Faculty has more required sessions than `max_per_week` |
| `FACULTY_DAILY_CAP_INFEASIBLE` | error | Faculty sessions exceed `max_per_day` x working days |
| `DIVISION_HOURS_OVER_CAPACITY` | error | For a division, the busiest batch's weekly hours exceed teachable hours per week |
| `SEMESTER_TOTAL_MISMATCH` | warning | `semester_total` differs from effective weekly count x term weeks (skipped without dates/total) |
| `FACULTY_NOT_LINKED` | info | Faculty has no linked Vyas profile |
| `LAB_KIND_MISMATCH` | warning | Lab subject with `per_batch=false`, or theory subject with `per_batch=true` |
| `LAB_NO_BATCHES` | warning | Lab offering in a division that only has the whole batch |
| `NO_DATES` | info | Term has no start/end dates |

When the pool has no lab rooms, `NO_LAB_ROOM`, `LAB_ROOMS_INSUFFICIENT` and `NO_ROOMS_IN_POOL` can all fire together; likewise an empty pool with theory offerings also raises `NO_CLASSROOM_ROOM`. Both new checks are pure functions in `domain/readiness.js` (`noDivisions`, `noClassroomRoom`) registered in `checks` / `ISSUE_CODES`.

## Import CSV columns

Header keys are case-insensitive and trimmed (spaces become underscores; the frontend also strips a trailing `*`). `*` = required. Completely blank rows are skipped. Real imports upsert on natural keys and **never delete** rows missing from the file; blank optional cells keep the stored value on update (see below). Order to import: faculty, subjects, divisions, offerings (the API also reports missing references as row errors).

| Entity | Columns | Natural key / notes |
|---|---|---|
| `faculty` | `short_code*, full_name*, email, department, max_per_day, max_per_week` | `short_code`, case-insensitive; global, not per term. Email linking to a profile happens automatically. `short_code` cannot contain `\| , ; :` |
| `subjects` | `code*, name*, kind* (theory\|lab), weekly_count*, semester_total, allow_second_lab (yes\|no\|true\|false\|1\|0), duration_min` | `code` per term. Blank `duration_min` = the term's theory/lab minutes |
| `divisions` | `semester*, division*, student_count*, home_room, batch, batch_size` | `(semester, division)` per term. One row per batch, repeating the division columns; conflicting repeated values are a row error; blank `batch` = division only. Also creates the batches and the hidden whole batch. `home_room` format: `<building name> / <room name>` (case-insensitive; missing or ambiguous is a row error) |
| `offerings` | `semester*, division*, subject_code*, faculty_codes*, batch, weekly_count, role` | `(division, subject_code)`. `faculty_codes` separated by `\|`, `,` or `;`, each optionally `CODE:assist`. Blank `batch` = all batches. Several rows for one `(semester, division, subject_code)` merge into one offering; disagreeing `weekly_count` is a row error. `role` = default role for codes without a suffix (default `lead`). Lab subjects get `per_batch=true` |

Import rules that matter when re-importing:

- **Limits are the API's limits.** Every length and number is checked against `services/planner/domain/limits.js`, the same constants the zod schemas in `services/planner/*.js` use (for example `weekly_count` 0..100, `semester_total` 0..10000, `duration_min` 1..1440, `student_count`/`batch_size` 0..100000, `semester` 1..12, `short_code`/`code` 40 characters, names 60..200, `faculty_codes` at most 200 entries). Anything outside is a row error in the dry run, and no integer can exceed `INT4_MAX` (2,000,000,000). Error messages shorten echoed values to 40 characters. Change a limit in `limits.js` only, so the API and the import cannot drift.
- **Blank = keep the stored value on UPDATE** (a CREATE uses the default): subjects `duration_min` (create: term default for the kind) and `allow_second_lab` (create: false); divisions `batch_size` on an existing batch (a new batch with a blank size warns and is created with 0 students); faculty `email` (the stored email and its profile link stay). A *given* faculty email re-links by it, and unlinks (`profile_id` NULL) when it matches no profile, exactly like `PATCH /faculty/:id`.
- Dry run and apply classify rows the same way (create / update).

Ready-made samples: `tests/planner/fixtures/{faculty,subjects,divisions,offerings}.csv` (3 semesters x 5 divisions, 12 faculty, 230 required sessions). Regenerate with `node tests/planner/fixtures/generateCsv.js`.

## Session generation and sync semantics

- **Effective weekly count** of an offering = `COALESCE(offering.weekly_count, subject.weekly_count)`.
- **Expansion** (`expectedSessions`): `per_batch = false` gives `effective` sessions on the division's *whole* batch (`seq` 1..n). `per_batch = true` gives, for each non-whole batch, `effective` sessions; if the division has no non-whole batches, the whole batch is used.
- **Faculty copy**: a session on batch B of offering O gets every `planner_offering_faculty` row of O where `batch_id = B` or `batch_id IS NULL` (NULL = every batch).
- `POST /versions/:id/sync-sessions` works on a **draft** version only (otherwise 409 `VALIDATION_ERROR`) and is **idempotent**. In one transaction, with the version row locked, it:
  - adds the missing sessions as **unplaced** (all placement columns NULL);
  - removes surplus **unplaced** sessions, highest `seq` first;
  - **never deletes a placed session**; surplus placed ones are reported in `placed_surplus: [{offering_id, batch_id, count}]`;
  - refreshes `planner_session_faculty` of existing **unplaced** sessions from the offering's current faculty. Placed sessions are never touched (their faculty rows are not rewritten and `rev` does not move for them);
  - bumps `planner_versions.rev` only if something changed.
- Response: `{ added, removed, kept, placed_surplus, by_division: [{division_id, semester, name, required, existing}], faculty_updated, rev }`.
- Deleting a division, offering or batch removes its unplaced sessions first and refuses with `HAS_PLACED_SESSIONS` if any is placed. It takes the term's version locks first (an editor op in flight finishes before the delete looks), deletes only `weekday IS NULL` rows and re-checks afterwards that no placed session is left for the scope. When sessions were deleted, the `rev` of the draft version(s) that held them is bumped once and the route emits `planner:changed {version_id, rev, prev_rev, client_id: null, sessions: null, refetch: true}` after commit (helper `routes/planner/emit.js`, shared with the editor and sync routes), so open editors refetch. Deleting a batch also deletes the `planner_occupancy` rows of kind `batch` that point at it (placed whole-division sessions keep one row per batch).

## Concurrency and structural guards (Phase 2 review round)

- **`lockTermVersions(db, termId)`** (`services/planner/guards.js`) locks every version row of a term in id order. Editor ops lock their version row first thing, so any structural write that takes the same locks waits for placements in flight and then sees them. Used by: `PATCH /terms/:id` (only when a grid setting really changes), pool room update/remove, offering/division/batch delete, subject `duration_min`/`kind` edits, division/batch `student_count` edits, batch create, and the subjects / divisions imports. Always take it BEFORE counting placed sessions.
- **Errors under load:** Postgres 40P01 / 40001 / 55P03 map to 409 `CONFLICT_RETRY` (see the error table; `routes/planner/errorMap.js`). `POST /versions/:id/ops` runs `SET LOCAL lock_timeout = '10000ms'` right after `BEGIN`, so a stuck lock holder cannot stall editor requests forever.
- **Sockets:** `join:planner` reserves its slot on arrival (before any await); the DB check and the join then run in a per-channel queue shared with `leave:planner`, so one socket's events for a room apply in arrival order. `leave:planner` only releases the reservation when the socket really is in the room.

## Database design notes

- 13 tables created by `015_planner_core.sql`: `planner_terms`, `planner_term_rooms`, `planner_faculty` (global), `planner_divisions`, `planner_batches`, `planner_subjects`, `planner_offerings`, `planner_offering_faculty`, `planner_versions`, `planner_sessions`, `planner_session_faculty`, `planner_occupancy`, `planner_rule_config`. Nothing existing is altered; `room_timetable_templates` and `bookings` are untouched in Phase 1.
- A term covers **all semesters** of a branch for an odd/even half; `planner_divisions.semester` carries 3/5/7. Unique on `(academic_year, half, branch)`.
- Each division has exactly one hidden **whole batch** (`is_whole`, name `ALL`, enforced by a partial unique index; created and kept in sync by the API, not a trigger). The API reserves the name `ALL`.
- **Foreign keys from `planner_sessions` / `planner_session_faculty` to offerings, batches, rooms and faculty are `NO ACTION`, not `RESTRICT`.** Both block a delete, but `NO ACTION` is checked at end of statement. That lets `DELETE ... FROM planner_terms` cascade through offerings, batches and sessions regardless of the order Postgres fires the cascades in, while a direct delete of an in-use row still fails (error 23503, mapped to `IN_USE`). With `RESTRICT` the check is immediate and a whole-term delete can trip over its own sessions.
- `planner_occupancy` has `EXCLUDE USING gist (version_id =, kind =, resource_id =, weekday =, during &&)` named `planner_occupancy_no_overlap`, **`DEFERRABLE INITIALLY IMMEDIATE`** (so Phase 2 can swap two sessions inside one transaction by deferring the check). The table and constraint exist, but **no Phase 1 code writes to it**; it is unused until Phase 2 populates it.
- `planner_sessions.seq` (>= 1, unique with version/offering/batch) gives sync a deterministic identity for "the 3rd weekly session of this offering for this batch".
- Placement is all-or-none: `weekday, start_min, end_min, room_id` are all NULL or all NOT NULL. Equality of session length and subject duration is not a DB check (cross-table); the Phase 2 engine must enforce it.
- Versions: one draft and at most one published per term (partial unique indexes); `rev` is the optimistic-concurrency counter for Phase 2.
- `DEFAULT_RULES` (19 rule keys: 7 blocking, 5 hard, 7 soft) are inserted into `planner_rule_config` for each new term; Phase 1 stores them but evaluates none.

## Phase 2: lab rooms shared by capacity (migration 016, contract 8.7)

A big lab (capacity about 62) can host two or three batches of about 30 at the same time. Classrooms stay exclusive.

- **Which sessions share.** A session is *shareable* when its subject is a `lab`, the chosen pool room has `is_lab = true` and `rooms.capacity` is a positive integer (`domain/roomShare.js` `isShareable`). Its room occupancy row gets the kind `lab_room`; every other session (theory, a lab in a classroom or in a room with unknown capacity) keeps the exclusive kind `room`. The kind is decided in `editor.js` `rewriteOccupancy`, so `place`, `move`, `set_room` and `set_faculty` always rewrite it correctly (a lab moved from a shared lab to a classroom switches `lab_room` to `room`, and back).
- **Database.** `016_planner_lab_sharing.sql` (idempotent, also mirrored into `schema.sql`) lets `planner_occupancy.kind` be `'lab_room'` and recreates `planner_occupancy_no_overlap` with `WHERE (kind <> 'lab_room')` (same columns, still `DEFERRABLE INITIALLY IMMEDIATE`). Each change is guarded by a look at `pg_get_constraintdef`, so a re-run does nothing. Faculty, batch and `room` rows are still protected by the constraint.
- **The capacity check is not in the database.** It runs in the pre-check of every write, inside the version-row lock (`getVersion(..., {lock:true})`), which is what makes it safe: requests on one version are serial.
  - An exclusive candidate (`room`) conflicts with any overlapping `room` or `lab_room` row of that room.
  - A shared candidate conflicts with overlapping `room` rows, and for overlapping `lab_room` rows the **peak concurrent student load** over the candidate's interval (existing sessions' students plus the candidate's, half-open intervals, sweep over the boundaries; `fitsInRoom`) must be <= `rooms.capacity`. Students = the batch's `student_count`, or the division's for the whole batch. The check always runs for a shared candidate, **also when it is alone in the room**: a session whose own students exceed the room capacity (a 70-student whole-division lab in a 62-seat room, 60 students in a 30-seat lab) is rejected with `ROOM_CAPACITY` and the sentence without the "it already has" part. Classrooms and non-shareable placements stay unchecked (manual room capacity for those is Phase 3), and auto-pick never offers a room whose capacity is below the session's own need.
  - Rejection is `409 CLASH` with `details.conflicts[{kind:'room', ...}]` (never `lab_room` on the wire) and, for capacity, `details.reason = 'ROOM_CAPACITY'`, e.g. "Room VY 027 (capacity 62) would hold 90 students on Monday 09:00–11:00; it already has LB for CSE-A (Sem 3) batch A1 (30 students) and LB for CSE-B (Sem 3) batch B1 (30 students)."
- **Auto room pick** (`domain/roomPick.js`): the service passes `roomLoads` (room -> `{exclusiveBusy, sharedPeak}` at the slot). A shareable lab goes to the fullest lab that still fits (ties: smaller capacity, then name), so labs pack into few rooms; labs in rooms of unknown capacity are only a last resort and exclusive. Theory is unchanged but a room with any shared load counts as busy. `busyRoomIds` is still accepted.
- **Guards that keep shared rooms consistent** (all take `lockTermVersions` first, so they serialise against placements in flight; API and import alike): flipping a pool room's `is_lab` while a placed session of the term uses it, changing a subject's `kind` while any session of it is placed, and changing the `student_count` of a batch (or of a division whose whole-division lab is placed) while that session currently has a `lab_room` occupancy row are all refused with 409 `LOCKED_BY_PLACEMENTS` (import: a row error). Other student-count edits stay allowed.
- **Known gaps (logged):** a room's capacity changed through the buildings routes does not re-check placed sessions; Phase 4 publish needs its own design for shared lab bookings (Vyas bookings forbid overlaps per room).
- Tests: `tests/planner/unit/{roomShare,occupancy,roomPick,explain}.test.js`, `tests/planner/sql/planner_schema.test.js` (constraint behaviour plus a throwaway `zz_planner_fresh_*` database that is dropped afterwards: fresh path, upgrade from the 015 state with rows, repeated application), `tests/planner/api/editorLabShare.test.js`.

## Not built yet / carry-forward

Source of truth: `PLANNER_LOG.md` in the parent folder. None of this exists in the code today.

**Phase 2 (editor and operations)**
- Timetable editor operations (place / move / swap / lock sessions), writing `planner_occupancy`, clash detection and `rev` conflict handling.
- An admin-only socket room for live editing (none exists today). `RoomCalendar` on the frontend calls `disconnectSocket()` on the shared singleton, which must be handled.
- A planner-specific rate limiter. Only the global limiter (200 requests / 15 min / IP) applies now, which the planner test suite exceeds.
- Decide how an offering's faculty change should reach already-placed sessions (sync deliberately leaves them alone), probably as an explicit editor action with a clash check.
- Known races, accepted for Phase 1 (no locking beyond the term/version row): concurrent creates of the same name can both pass the pre-check and one then fails on the unique index (it surfaces as `DUPLICATE`, not corruption); concurrent faculty/offering edits against a running sync are last-writer-wins.
- (Done in Phase 2) The planner has its own rate limiter. The `/planner` JSON parsers still run before authentication, so up to 100 KB (2 MB on import routes) is read from anyone before a 401; the limits are now small and path-specific.

**Phase 3 (rules and help)**
- Rule engine that actually evaluates `planner_rule_config`, diagnostics, and suggestions.

**Phase 4 (publish)**
- `room_timetable_templates` needs an `effective_until` column.
- `get_effective_timetable` has no end bound and an 8-day window bug; fix it.
- The booking overlap trigger / exclusion constraint and `GET /buildings/rooms/free` ignore timetable templates (free-rooms also ignores `bookings.status`).
- Published templates must set `repeat_interval_weeks = 1`.
- `check_slot_availability()` exists in SQL but is not used by any JS.
- Versions UI, exports, publish/historical lifecycle.

**Doc drift noted elsewhere (not planner code)**: backend `CLAUDE.md` still describes JWT/password auth, has a stale 23P01 note and an out-of-date repo tree; `REMEDIATION-LOG.md` has no entry for the OTP/sessions rewrite; `database/schema.sql` lacks `audit_events` and the import-job columns from migrations 003/004.


## Phase 3: generator, rule engine, diagnostics, suggestions (migrations 017 and 018, contract section 9)

The system generates the timetable from the term data and the term's rule config; the admin edits the result. Spec: `VY/PLANNER_CONTRACT.md` section 9 (9.9 = review amendments). Handoff: `VY/handoffs/tt_phase3_handoff.md`.

**Folder map**
- `services/planner/engine/` (pure, no DB): `time.js`, `model.js`, `rank.js`, `rotation.js`, `config.js` (rule rows -> weights/limits), `generate.js` (the generator), `repair.js`, `diagnose.js`, `suggest.js`, `evaluate.js` + `rules/*` (23 rule keys), `index.js`. The harness in `tests/planner/real/` is the historical regression harness (do not edit; a parity test compares the engine with it).
- `domain/ruleDefaults.js` (23 keys), `domain/ruleSpec.js` (labels, params, validation; served by `GET /terms/:id/rules`), `services/planner/rules.js` (load/patch/reset; stored rows merged over defaults, upsert).
- `services/planner/editor.js`: `applyPlacements` (the generator's write path: chunks of about 100, savepoint per unit, `expect` stale guard, `atomic`, per-unit `fallback`).
- `services/planner/{generation,generationRunner,generationWorker}.js`: run row in `planner_generation_runs` + a `worker_threads` thread (works with `RUN_WORKERS=false`; max 2 threads per process), progress polled over REST, heartbeat + lazy/60 s sweep (2 min), `cancel_requested`, crash-safe `after_placements` per chunk, atomic undo, retention (newest 20 runs per version).
- Routes (all `/planner`, admin only): `GET/PATCH /terms/:id/rules`, `POST /terms/:id/rules/reset`, `GET /versions/:id/diagnostics`, `GET /sessions/:id/candidates`, `GET /sessions/:id/suggestions`, `POST /versions/:id/generate`, `GET /versions/:id/generation`, `GET /generation-runs/:id`, `POST /generation-runs/:id/cancel|undo`.
- Migrations: `017_planner_generation.sql` (table), `018_planner_generation_heartbeat.sql` (`heartbeat_at`, `cancel_requested`, `instance_id`); both mirrored in `schema.sql`; applied to the LOCAL DB only.

**Behaviour to know**
- Default mode `fill_unplaced` never moves a placed session; `regenerate_unlocked` needs `confirm:true`; locked sessions are always kept; each run can be undone (latest run that committed placements).
- `faculty_daily_load.default_max_hours` is a penalty only; only an explicit `faculty.max_per_day` is a hard filter. `time_of_day` diagnoses only late starts.
- Diagnostics are computed per request (no cache; 60-300 ms on 949 sessions).

**Tests** (`RUN_WORKERS=false PLANNER_ENABLED=true PORT=3100 node app.js`, then `BASE_URL=http://localhost:3100 npm run test:planner`): 639 tests (unit incl. 9 engine and 9 rule files, SQL incl. rules service and migrations 017/018, API incl. rules, diagnostics, suggestions, generation, `applyPlacements`). Offline harness: `node --test "tests/planner/real/*.test.mjs"` (84). Scripts that import `tests/planner/api/_util.js` leave a Redis handle open: end them explicitly.
