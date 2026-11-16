# Placement strategy of the real-data test timetable

This describes how `autoplace.mjs` builds the Sem 3 + Sem 5 test timetable. The rules are patterns learned from the way the admin works (summarised in `fixtures/real/REPORT.md` section 6), written as explicit rules with reasons. **No cell of the admin's grids is used**: the harness never opens the workbooks, and `pattern_stats.json` is read only by `analyze.mjs` after the timetable exists, to compare headline numbers.

Code map: `lib/rotation.mjs` (lab blocks), `lib/rank.mjs` (candidates and penalties), `lib/model.mjs` (occupancy model), `lib/engine.mjs` (the loop and the server dialogue). All of them are pure and unit-tested offline.

## 1. The server is the authority

The harness keeps its own in-memory model of occupancy (teachers, batch resources, rooms, shared lab loads), built from `GET /planner/versions/:id/snapshot`, so that almost every proposal is valid. Every placement still goes through `POST /planner/versions/:id/ops`:

| answer | meaning for the harness |
|---|---|
| 200 | write the placement and the **room the server chose** (`results[].room_id`) into the model |
| 409 `CLASH`, 409 `NO_ROOM_AVAILABLE`, 422 `PLACEMENT_INVALID` | recorded (code, message, `op_index`), next ranked candidate. The model had predicted success, so this counts as a *model mismatch* |
| 409 `SESSION_LOCKED` | the unit is skipped |
| anything else (400, 404, 409 `NOT_DRAFT`, 401/403, 5xx) | fatal: a harness bug or an environment problem; the run stops with the server's message |

How the model recovers after a refusal: a `CLASH` whose holder session the model does not know to be at that slot means **state drift** and triggers a re-fetch of the snapshot; otherwise (and for `NO_ROOM_AVAILABLE`) the model is re-synced after every 5th mismatch. At most 40 re-syncs per run (a snapshot is large and the planner limiter allows 3000 requests / 15 min / IP; a full run needs roughly 700-1000 ops requests). A 429 is waited out using `Retry-After` / `RateLimit-Reset`.

Pre-8.7 servers: if three lab placements that joined an already shared room are refused as exclusive-room conflicts, the model switches itself to exclusive labs (and says so). Without sharing a 24-lab pool still works, only with more refusals.

Atomicity: a lab block is one request with one `place` op per batch (all-or-nothing, at most one `rev` bump); theory is one op per request. `client_id` is stable (`real-autoplace-<seed>`).

## 2. Order: most constrained first

1. **Lab blocks before theory.** Labs are the scarcest resource (many batches in parallel, two teachers, 24 lab rooms shared by 40 divisions, 2-hour blocks that only fit four columns a day). Theory has many small, flexible slots and fills the gaps around the labs.
2. **Divisions by faculty load.** A division's priority is the mean, weighted by session hours, of the weekly load of the *heaviest teacher of each session*; ties by number of lab subjects, then by name. Heavily loaded teachers (the data has one at 32 h/week, 80% of the teachable week) are placed while their calendar is still empty.
3. **Sessions inside a division:** theory sorted by the heaviest teacher's load, then weekly count, then subject code; lab blocks biggest first.
4. Phases: lab blocks (strict) -> leftover lab sessions one by one (relaxed) -> theory (strict) -> theory leftovers (relaxed) -> a last single-session lab sweep.

Two passes per phase: **strict** and **relaxed**. The relaxed pass only turns *preferences* into penalties: any grid-valid start instead of the standard cells, and a 7th teaching hour for a division. **Three rules stay hard in every pass** (the brief states them as absolutes): at most one lab block per batch per day (so a batch never has two lab subjects on one day), at most one lecture of a subject per day (a second one only back to back and only when the weekly count exceeds the working days), and a teacher's `max_per_day` when set. A session that only fits by breaking one of them is left **unplaced** with the reason code `POLICY_RULES` instead of silently breaking the rule.

Reason codes of unplaced sessions (`out/autoplace_run.json`, report section 2): `FACULTY_BUSY`, `DIVISION_BUSY`, `NO_ROOM` (no free slot at all; the text counts the blocked slots), `POLICY_RULES` (free slots exist but each breaks a hard rule), `SERVER_REFUSED` / `TRY_LIMIT` (the model saw a free slot but the server refused every candidate tried), `LOCKED`.

## 3. Lab blocks

A *lab block* is a set of lab sessions of one division that run at the same time, one session per batch, on different lab subjects, with disjoint teachers.

* **Latin-square rotation** (`latinRounds`): with `k` batches and `L` lab subjects take `n = max(k, L)`; in round `r` batch `i` gets subject `(i + r) mod n` (a cell is empty when that index is `>= L`). Every batch meets every lab subject exactly once and no round repeats a subject. *Reason: this is what the admin's rotations look like (every batch meets every subject once per week, parallel batches on different subjects) and it keeps lab rooms and teachers from being double-loaded.* For `k = L = 3` the rounds are `[0 1 2] [1 2 0] [2 0 1]`; for `k = L = 2`, `[0 1] [1 0]`.
* **Teachers inside a block must be disjoint.** If one teacher teaches two lab subjects of the same division, those two cannot run in parallel. The builder permutes the order of the subjects (up to 720 permutations) to find the arrangement with the fewest forced splits, moves the sessions that still collide into other blocks, and finally merges blocks that can run in parallel (no common batch, disjoint teachers; e.g. one subject with a different teacher per batch). *Reason: otherwise the server answers 409 CLASH for a block that can never succeed.*
* **Two teachers on one session** (lead + assist): both are on the session and both must be free (the model checks every faculty id of the session).
* **Candidate starts:** the *standard cells* of the term, i.e. back-to-back 60-minute cells counted from the day start and from the end of every break (default term: 08:30 09:30 10:45 11:45 13:30 14:30 15:45 16:45). A 120-minute lab must fit between two breaks, which leaves **08:30, 10:45, 13:30, 15:45**.
* **Preference** (penalty): 10:45 = 0, 13:30 = 1, 08:30 = 2, 15:45 = 8, any other start 6 (relaxed pass only). *Reason: the labs of the admin cluster at 10:45 and 13:30, 08:30 is common, 15:45 is rare.*
* **At most one lab block per batch per day** and **a batch never has two lab subjects on one day** (hard filter in every pass). *Reason: students do not get two labs a day; this also spreads the lab load over the week.* The 5-day week is enough for up to 5 blocks per division.
* Blocks of one division prefer non-adjacent days (penalty 1.5 per lab block on an adjacent day).

## 4. Theory

One-hour sessions, always sent **without `room_id`**: the server picks the division's home room if it is free, else the smallest free classroom that fits.

Hard filters:

* The slot is feasible: teacher(s) free, the division's batch resources free (a whole-division lecture also needs every batch free), and a free classroom exists (the model replicates the server's pick).
* **A subject at most once per day** (hard in every pass), unless its weekly count exceeds the number of working days; then a second lecture is allowed only **back to back** with the first. *Reason: spreading a subject over the week is the dominant habit; repeats in the admin's grids are mostly back-to-back double slots.*
* A division has at most **6 teaching hours** a day (labs included).
* A teacher's `max_per_day`, when set (null in the real data), is never exceeded, even in the relaxed pass.

Penalties (lower = better; all weights are in `lib/rank.mjs`, `WEIGHTS`):

| rule | penalty | reason |
|---|---|---|
| start in the core window 10:45-15:30 | 0 | preferred hours |
| start 08:30-10:30 | 3 | second choice |
| start at/after 15:45 | 12 (+4 from 16:45) | late slots are almost unused by the admin |
| hours already taught to the division that day | 2.0 per hour | "prefer the least loaded day": spreads the week evenly |
| same subject on the same day (only the allowed back-to-back repeat can reach this) | 6 per session | spread a subject over different days |
| same subject on an adjacent day | 1.5 per session | prefer Mon/Wed/Fri-like spacing |
| division run > 3 consecutive hours | 15 per extra hour (delta caused by this placement) | avoid long unbroken stretches |
| teacher run > 3 consecutive hours | 10 per extra hour (the most affected teacher) | same, for teachers |
| new idle gap in the division's day | 3 per idle hour | the day should be contiguous |
| hours already taught by the busiest involved teacher that day | 1.0 per hour | keep a teacher's day balanced |
| predicted room is not the division's home room | 0.5 | prefer the home room |
| 7th+ teaching hour (relaxed pass only) | 20 per hour | |
| start not on a standard cell (relaxed only) | 5 | |
| seeded jitter | up to 0.3 | deterministic tie-break (below) |

**Definitions.** A *run* is back-to-back teaching; it continues over a short break (10:30-10:45, 15:30-15:45) but is cut by free time and by the lunch break (any break of 30 minutes or more). An *idle gap* is free time (breaks excluded) between two sessions of the same division on the same day. A division's day is the union of the intervals of all its batches. Breaks, working days, day bounds and the grid are read from the snapshot's `term`.

## 5. Rooms

* `--lab-rooms=auto` (default): lab ops carry no `room_id`; the server packs batches into the fullest lab room that still fits (contract 8.7.4). The model mirrors this choice to predict `NO_ROOM_AVAILABLE`.
* `--lab-rooms=affinity`: each lab session carries an explicit `room_id` from `lab_rooms.json` (`subject -> division -> batch (or '*') -> workbook room codes`), mapped to a pool room through `_room_mapping` (e.g. `VY027` -> `Vyas / VY 027`). A batch's candidates are its own rooms followed by the `*` rooms; the first that fits is used (shared by capacity). Unmapped rooms (`VY126`, `KS...`, `DR...`) give no affinity, so those sessions are sent without `room_id` (auto). If no slot works with the affinity rooms, the block is retried once in auto mode (counted as an *affinity fallback*).
* Classrooms are exclusive; shared labs follow 8.7 (lab subject + lab room with a positive capacity; the sum of the concurrent batch sizes must stay within capacity).

## 6. Determinism

All tie-breaks use `hash(seed | semester|division | subject | batch | seq | day | start)` or sort by natural keys (`semester|name`, subject code, batch name), **never database ids or the order of the snapshot**: re-seeding with `--reset` (new UUIDs) and the same `--seed` produces the same timetable. Divisions are always keyed by `semester|name` because every division name exists in both semesters. A unit test renames all ids and reverses the snapshot order and compares the result.

## 7. What is deliberately not modelled

Common blocks (Cognitive Skills, SCHIE, MCPT), Eval / Mentor-Mentee meetings and University Elective (Saturday) are not offerings in the data and are not placed. Batch practicals of theory-named subjects are lab subjects with `weekly_count` 1 per batch (the grids sometimes show two). The 7 teacher clashes of the hand-made grids (possibly combined lectures) cannot exist here.

## 8. Offline check

`simulate.mjs` runs the whole pipeline against an in-process fake server (no HTTP, DB or Redis) built from the same CSVs, with an independent brute-force clash checker, and writes `out/sim_report.md`. In the development runs all 949 sessions were placed with the default term in about 720 ops requests, with zero model mismatches, zero integrity violations and 0.8% of the cells at/after 15:45. That is a check of the strategy and of the wiring, not a prediction of the live result (the live server may refuse things the fake does not).
