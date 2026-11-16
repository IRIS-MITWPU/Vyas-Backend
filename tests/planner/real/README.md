# Real-data test timetable (Sem 3 + Sem 5): harness

A **test harness**, not a product feature. It seeds a `REAL-TEST` planner term from the generated inputs in `../fixtures/real/`, places every generated session through the public `POST /planner/versions/:id/ops` API with an explicit set of scheduling rules (`PLACEMENT_STRATEGY.md`), and then measures the result. Everything goes through the HTTP API, so it also exercises clash detection (contract section 8).

It never reads the admin's workbooks; the hand-made grids appear only as `fixtures/real/pattern_stats.json`, used by `analyze.mjs` for the final comparison.

## How to run (live)

Prerequisites: local Postgres + Redis, migrations applied (including 015/016), and the server started from `Vyas-Backend` with the planner on and no real email:

```bash
cd Vyas-Backend
PLANNER_ENABLED=true RUN_WORKERS=false npm run dev      # terminal 1
```

All scripts are run from `Vyas-Backend` (dotenv reads `.env` from the working directory). They mint a session for `admin@mitwpu.edu.in` with `tests/helpers/auth.js` (the only database access; the session row is deleted at the end). `BASE_URL` defaults to `http://localhost:3000`; `PLANNER_COOKIE="name=value"` skips the database completely.

```bash
# 1. seed: term 2026-27 / odd / REAL-TEST, import faculty -> subjects -> divisions -> offerings,
#    add all active Vyas rooms to the pool, print readiness, sync sessions
node tests/planner/real/seed_real_term.mjs            # reuses an existing REAL-TEST term
node tests/planner/real/seed_real_term.mjs --reset    # deletes it first (plain SQL, only if branch = 'REAL-TEST')

# 2. place everything through /ops
node tests/planner/real/autoplace.mjs                                  # auto lab rooms (server packs shared labs)
node tests/planner/real/autoplace.mjs --lab-rooms=affinity --seed 2    # rooms from lab_rooms.json where mapped
node tests/planner/real/autoplace.mjs --fresh                          # unplace everything first and start over

# 3. analyse (read-only API) -> real_run_report.md + real_run_metrics.json
node tests/planner/real/analyze.mjs
```

`autoplace.mjs` options: `--term <id>` (default: the REAL-TEST term), `--lab-rooms=auto|affinity`, `--seed N` (default 1), `--fresh`, `--shared-labs=on|off` (what the in-memory model assumes; it switches itself off when the server does not share labs), `--base-url URL`. It prints the limiter headers it sees, progress per division and a summary (placed/unplaced, refusals by code, resyncs, integrity) and writes `out/autoplace_run.json` (marked `incomplete` while running; on a fatal server answer it keeps the partial stats and a `fatal` field). `analyze.mjs` picks it up for the list of unplaced sessions and their reasons, but ignores it (with a warning, and a line in the report header) when it belongs to another version, and flags it when it is incomplete. `analyze.mjs` also accepts `--run-log FILE`, `--snapshot-file FILE` (analyse a saved snapshot without any server) and `--save-snapshot`.

Exit codes: 0 ok, 1 error, 3 the final snapshot has an integrity violation.

The planner limiter allows 3000 requests / 15 min / IP; a full run uses roughly 700-1000 ops requests plus a few snapshot reads. A 429 is waited out using `Retry-After`. The scripts never print the cookie, `REDIS_URL` or the database password, and never touch Redis.

## Offline (no server, no database, no Redis)

```bash
node --test "tests/planner/real/*.test.mjs"          # 84 unit tests, about 10 s
node tests/planner/real/simulate.mjs [--seed N] [--lab-rooms=affinity]   # whole pipeline against an in-process fake server
```

`simulate.mjs` builds the world from the four CSVs, runs the same engine against a fake `ops` endpoint and writes `out/sim_report.md` / `out/sim_metrics.json` (it does not touch `real_run_report.md`). These tests are a separate suite: they are not part of `npm run test:planner`.

## Files

| file | purpose |
|---|---|
| `seed_real_term.mjs`, `autoplace.mjs`, `analyze.mjs` | the three live steps |
| `simulate.mjs` | offline dry run against a fake server |
| `PLACEMENT_STRATEGY.md` | every scheduling rule with its reason |
| `lib/csv.mjs`, `lib/api.mjs`, `lib/session.mjs`, `lib/fixtures.mjs`, `lib/args.mjs`, `lib/term.mjs` | I/O helpers (`session.mjs` is the only one that touches the database) |
| `lib/time.mjs`, `lib/model.mjs`, `lib/rotation.mjs`, `lib/rank.mjs`, `lib/engine.mjs`, `lib/labrooms.mjs` | pure logic: grid helpers, occupancy model, Latin rotation, candidates and ranking, the loop (server injected), lab-room affinity |
| `lib/integrity.mjs`, `lib/metrics.mjs`, `lib/report.mjs` | independent clash checker, quality metrics and the comparison with `pattern_stats.json`, markdown report |
| `lib/world.mjs`, `lib/fakeServer.mjs`, `lib/testkit.mjs` | snapshot builder from the CSVs, in-process fake ops endpoint, test helpers |
| `*.test.mjs` | node:test unit tests of the pure parts |
| `out/` | generated run logs (ignored by git) |

## Caveats

* The faculty import upserts **global** faculty rows by `short_code`; if rows with those codes already exist (another term, the dev database) their names are updated.
* "All active rooms" puts the Alpha Building `- Test` rooms (capacity 60, which beats 62 on the server's smallest-fit rule, so they are the first theory fallback) and the 6-seat discussion rooms into the pool. They are left in on purpose.
* `VY126` (DBMS lab of every AIDS panel in Sem 3) and the `KS...` / `DR...` rooms are not in the Vyas rooms table, so `--lab-rooms=affinity` falls back to the server's room choice for them.
* The generated timetable is clash-free by construction; the hand-made grids are not (REPORT.md lists 7 teacher clashes and 1 room double-booking), so the comparison of "violations" is not like for like.
