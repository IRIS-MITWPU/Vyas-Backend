// Planner API: CSV/XLSX import (dry run vs apply, rollback, idempotency, references) and the 2 MB body limit.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, openSessions, newUid, scope, cleanup, makeTerm, http } from "./_util.js";
import { fixtureRows, importEntity, importAll } from "./_fixtures.js";

const s = scope(newUid());
let sessions;
let api;

before(async () => {
  sessions = await openSessions();
  api = sessions.api;
});
after(() => cleanup(s, sessions));

const count = async (sql, params) => (await pool.query(sql, params)).rows[0].n;
const facultyCount = () => count("SELECT count(*)::int AS n FROM planner_faculty WHERE short_code LIKE $1", [`${s.prefixCode}%`]);

test("GET /import-templates lists the four entities with columns and sample rows", async () => {
  const res = await api("GET", "/import-templates");
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body.templates).sort(), ["divisions", "faculty", "offerings", "subjects"]);
  for (const t of Object.values(res.body.templates)) {
    assert.ok(t.columns.length && t.sample_rows.length);
    for (const k of ["key", "label", "required", "description", "example"]) assert.ok(k in t.columns[0], k);
  }
  assert.deepEqual(res.body.templates.faculty.columns.map((c) => c.key),
    ["short_code", "full_name", "email", "department", "max_per_day", "max_per_week"]);
});

test("faculty import: dry run persists nothing, apply creates, re-import is all update, blank optionals keep values, profile linked by email", async () => {
  const term = await makeTerm(api, s);
  const rows = fixtureRows(s).faculty;
  rows[0].email = "ramesh.sharma@mitwpu.edu.in"; // an existing Vyas profile
  const { rows: [profile] } = await pool.query("SELECT id FROM profiles WHERE email = 'ramesh.sharma@mitwpu.edu.in'");
  assert.ok(profile);

  const dry = await importEntity(api, term.id, "faculty", rows, true);
  assert.equal(dry.status, 200);
  assert.equal(dry.body.success, true);
  assert.equal(dry.body.dry_run, true);
  assert.equal(dry.body.applied, false);
  assert.deepEqual(dry.body.summary, { total: 12, create: 12, update: 0, error: 0 });
  assert.deepEqual(Object.keys(dry.body.rows[0]).sort(), ["errors", "key", "row", "status", "warnings"]);
  assert.equal(dry.body.rows[0].row, 1);
  assert.equal(await facultyCount(), 0, "dry run wrote nothing");

  const real = await importEntity(api, term.id, "faculty", rows);
  assert.equal(real.status, 200);
  assert.equal(real.body.applied, true);
  assert.equal(real.body.dry_run, false);
  assert.deepEqual(real.body.summary, { total: 12, create: 12, update: 0, error: 0 });
  assert.equal(await facultyCount(), 12);
  const linked = await pool.query("SELECT profile_id FROM planner_faculty WHERE lower(short_code) = lower($1)", [rows[0].short_code]);
  assert.equal(linked.rows[0].profile_id, profile.id, "profile linked by email");

  // classification matches the dry run: everything is an update the second time
  const dry2 = await importEntity(api, term.id, "faculty", rows, true);
  assert.deepEqual(dry2.body.summary, { total: 12, create: 0, update: 12, error: 0 });
  const again = await importEntity(api, term.id, "faculty", rows);
  assert.deepEqual(again.body.summary, { total: 12, create: 0, update: 12, error: 0 });
  assert.equal(await facultyCount(), 12);

  // short_code match is case-insensitive; blank optionals keep what is stored; name is updated
  const partial = await importEntity(api, term.id, "faculty", [{ short_code: rows[1].short_code.toUpperCase(), full_name: "New Name", email: "", department: "", max_per_day: "", max_per_week: "" }]);
  assert.equal(partial.body.summary.update, 1);
  const kept = await pool.query("SELECT full_name, department, max_per_day, short_code FROM planner_faculty WHERE lower(short_code) = lower($1)", [rows[1].short_code]);
  assert.equal(kept.rows[0].full_name, "New Name");
  assert.equal(kept.rows[0].department, rows[1].department);
  assert.equal(kept.rows[0].max_per_day, rows[1].max_per_day);
  assert.equal(kept.rows[0].short_code, rows[1].short_code, "stored casing is kept");
  assert.equal(await facultyCount(), 12);
});

test("request validation: dryRun must be true/false, entity known, rows an array of at most 2000", async () => {
  const term = await makeTerm(api, s);
  const row = [{ code: "A", name: "A", kind: "theory", weekly_count: 1 }];
  assert.equal((await api("POST", `/terms/${term.id}/import/subjects?dryRun=maybe`, { rows: row })).status, 400);
  assert.equal((await api("POST", `/terms/${term.id}/import/rooms`, { rows: row })).status, 400);
  assert.equal((await api("POST", `/terms/${term.id}/import/subjects`, { rows: "nope" })).status, 400);
  assert.equal((await api("POST", `/terms/${term.id}/import/subjects`, {})).status, 400);
  const tooMany = await api("POST", `/terms/${term.id}/import/subjects?dryRun=true`, { rows: Array.from({ length: 2001 }, (_, i) => ({ code: `C${i}`, name: "x", kind: "theory", weekly_count: 1 })) });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.code, "VALIDATION_ERROR");
  assert.equal((await api("POST", "/terms/00000000-0000-4000-8000-000000000000/import/subjects?dryRun=true", { rows: row })).status, 404);
  assert.equal((await sessions.userApi("POST", `/terms/${term.id}/import/subjects`, { rows: row })).status, 403);
  // blank rows are skipped, junk rows are row errors rather than a crash
  const junk = await api("POST", `/terms/${term.id}/import/subjects?dryRun=true`, { rows: [{}, "text", null, { code: "", name: "", kind: "" }, { code: "only" }] });
  assert.equal(junk.status, 200);
  assert.equal(junk.body.summary.error, 3, "a string, null and a half-filled row are errors; fully blank rows are skipped");
});

test("a real run with any error row applies nothing: 422 IMPORT_HAS_ERRORS with the full result", async () => {
  const term = await makeTerm(api, s);
  const rows = [
    { code: "OK1", name: "Fine one", kind: "theory", weekly_count: 3 },
    { code: "OK2", name: "Fine two", kind: "lab", weekly_count: 1 },
    { code: "BAD", name: "Broken", kind: "practical", weekly_count: 1 },
    { code: "OK3", name: "Fine three", kind: "theory", weekly_count: 2 },
  ];
  const dry = await importEntity(api, term.id, "subjects", rows, true);
  assert.equal(dry.status, 200, "a dry run with errors is still a 200");
  assert.deepEqual(dry.body.summary, { total: 4, create: 3, update: 0, error: 1 });
  assert.equal(dry.body.rows[2].status, "error");
  assert.equal(dry.body.rows[2].errors[0].field, "kind");

  const res = await importEntity(api, term.id, "subjects", rows);
  assert.equal(res.status, 422);
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, "IMPORT_HAS_ERRORS");
  assert.equal(res.body.applied, false);
  assert.deepEqual(res.body.summary, { total: 4, create: 3, update: 0, error: 1 });
  assert.equal(res.body.rows.length, 4);
  assert.deepEqual(res.body.details, { summary: res.body.summary, rows: res.body.rows }, "result also inside details for apiClient");
  assert.equal(await count("SELECT count(*)::int AS n FROM planner_subjects WHERE term_id = $1", [term.id]), 0, "nothing persisted");

  // the same file without the bad row applies fully
  const fixed = await importEntity(api, term.id, "subjects", rows.filter((r) => r.code !== "BAD"));
  assert.equal(fixed.status, 200);
  assert.equal(await count("SELECT count(*)::int AS n FROM planner_subjects WHERE term_id = $1", [term.id]), 3);
  const durations = (await pool.query("SELECT code, duration_min FROM planner_subjects WHERE term_id = $1 ORDER BY code", [term.id])).rows;
  assert.deepEqual(durations.map((d) => d.duration_min), [60, 120, 60], "blank duration_min takes the term default for the kind");

  // a failure in the middle of the apply (a value the DB refuses, which validation lets through: a NUL character) rolls back the rows applied before it
  const midApply = await importEntity(api, term.id, "subjects", [
    { code: "MID1", name: "Before", kind: "theory", weekly_count: 1 },
    { code: "MID2", name: "Nul\u0000byte", kind: "theory", weekly_count: 1 },
  ]);
  assert.ok(midApply.status >= 400, "the apply failed");
  assert.equal(await count("SELECT count(*)::int AS n FROM planner_subjects WHERE term_id = $1 AND code LIKE 'MID%'", [term.id]), 0);

  // an offerings file with one bad row applies none of its rows
  const fac = await importEntity(api, term.id, "faculty", [{ short_code: `${s.prefixCode}RB`, full_name: "Rollback" }]);
  assert.equal(fac.status, 200);
  const div = await importEntity(api, term.id, "divisions", [{ semester: 3, division: "R-A", student_count: 30, batch: "R1", batch_size: 10 }]);
  assert.equal(div.status, 200);
  const before = await count("SELECT count(*)::int AS n FROM planner_offerings o JOIN planner_divisions d ON d.id = o.division_id WHERE d.term_id = $1", [term.id]);
  const mixed = await importEntity(api, term.id, "offerings", [
    { semester: 3, division: "R-A", subject_code: "OK1", faculty_codes: `${s.prefixCode}RB` },
    { semester: 3, division: "R-A", subject_code: "OK2", faculty_codes: `${s.prefixCode}RB`, batch: "NOPE" },
  ]);
  assert.equal(mixed.status, 422);
  assert.equal(await count("SELECT count(*)::int AS n FROM planner_offerings o JOIN planner_divisions d ON d.id = o.division_id WHERE d.term_id = $1", [term.id]), before);
});

test("full import faculty -> subjects -> divisions -> offerings, then an identical re-import is all updates and changes nothing", async () => {
  const term = await makeTerm(api, s);
  const rows = fixtureRows(s);
  const first = await importAll(api, term.id, rows);
  for (const [entity, res] of Object.entries(first)) {
    assert.equal(res.status, 200, `${entity}: ${JSON.stringify(res.body).slice(0, 300)}`);
    assert.equal(res.body.summary.error, 0, entity);
    assert.equal(res.body.summary.update, entity === "faculty" ? 12 : 0, entity);
  }
  assert.equal(first.subjects.body.summary.create, 8);
  assert.equal(first.divisions.body.summary.create, 45, "one row per batch: 15 divisions x 3");
  assert.equal(first.offerings.body.summary.create, rows.offerings.length);

  const snapshot = async () => ({
    subjects: await count("SELECT count(*)::int AS n FROM planner_subjects WHERE term_id = $1", [term.id]),
    divisions: await count("SELECT count(*)::int AS n FROM planner_divisions WHERE term_id = $1", [term.id]),
    batches: await count("SELECT count(*)::int AS n FROM planner_batches b JOIN planner_divisions d ON d.id = b.division_id WHERE d.term_id = $1", [term.id]),
    wholeBatches: await count("SELECT count(*)::int AS n FROM planner_batches b JOIN planner_divisions d ON d.id = b.division_id WHERE d.term_id = $1 AND b.is_whole", [term.id]),
    offerings: await count("SELECT count(*)::int AS n FROM planner_offerings o JOIN planner_divisions d ON d.id = o.division_id WHERE d.term_id = $1", [term.id]),
    offeringFaculty: await count(
      "SELECT count(*)::int AS n FROM planner_offering_faculty f JOIN planner_offerings o ON o.id = f.offering_id JOIN planner_divisions d ON d.id = o.division_id WHERE d.term_id = $1", [term.id]),
    perBatchLabs: await count(
      "SELECT count(*)::int AS n FROM planner_offerings o JOIN planner_divisions d ON d.id = o.division_id JOIN planner_subjects s ON s.id = o.subject_id WHERE d.term_id = $1 AND s.kind = 'lab' AND o.per_batch", [term.id]),
    perBatchTheory: await count(
      "SELECT count(*)::int AS n FROM planner_offerings o JOIN planner_divisions d ON d.id = o.division_id JOIN planner_subjects s ON s.id = o.subject_id WHERE d.term_id = $1 AND s.kind = 'theory' AND o.per_batch", [term.id]),
  });
  const snap1 = await snapshot();
  assert.equal(snap1.subjects, 8);
  assert.equal(snap1.divisions, 15);
  assert.equal(snap1.batches, 15 * 4, "ALL + 3 batches per division");
  assert.equal(snap1.wholeBatches, 15);
  assert.equal(snap1.perBatchTheory, 0);
  assert.ok(snap1.perBatchLabs > 0, "lab offerings are per_batch");
  const labOfferings = await count(
    "SELECT count(*)::int AS n FROM planner_offerings o JOIN planner_divisions d ON d.id = o.division_id JOIN planner_subjects s ON s.id = o.subject_id WHERE d.term_id = $1 AND s.kind = 'lab'", [term.id]);
  assert.equal(snap1.perBatchLabs, labOfferings);

  // dry run first: classification matches what the real re-import will do
  for (const entity of ["faculty", "subjects", "divisions", "offerings"]) {
    const dry = await importEntity(api, term.id, entity, rows[entity], true);
    assert.equal(dry.body.summary.create, 0, `${entity} dry run`);
    assert.equal(dry.body.summary.update, rows[entity].length, `${entity} dry run`);
    const real = await importEntity(api, term.id, entity, rows[entity]);
    assert.equal(real.status, 200);
    assert.deepEqual(real.body.summary, dry.body.summary, `${entity}: real run classified like the dry run`);
  }
  assert.deepEqual(await snapshot(), snap1, "nothing added or removed by the second import");

  // never deletes rows absent from the file
  const subset = await importEntity(api, term.id, "subjects", rows.subjects.slice(0, 2));
  assert.equal(subset.body.summary.update, 2);
  assert.equal((await snapshot()).subjects, 8);
  const divSubset = await importEntity(api, term.id, "divisions", rows.divisions.slice(0, 3));
  assert.equal(divSubset.status, 200);
  assert.equal((await snapshot()).divisions, 15);
});

test("divisions import: home room resolution, batches, whole batch mirrors student_count, bad rooms are row errors", async () => {
  const term = await makeTerm(api, s);
  const { rows: [room] } = await pool.query(
    "SELECT r.id, r.name, b.name AS building FROM rooms r JOIN floors f ON f.id = r.floor_id JOIN buildings b ON b.id = f.building_id WHERE r.is_active ORDER BY b.name, r.name LIMIT 1");
  const label = `${room.building} / ${room.name}`;
  const rows = [
    { semester: 3, division: "H-A", student_count: 60, home_room: label.toUpperCase(), batch: "H1", batch_size: 30 },
    { semester: 3, division: "H-A", student_count: 60, home_room: label, batch: "H2", batch_size: 30 },
    { semester: 3, division: "H-B", student_count: 45 },
  ];
  const res = await importEntity(api, term.id, "divisions", rows);
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
  const divs = (await api("GET", `/terms/${term.id}/divisions`)).body.divisions;
  const a = divs.find((d) => d.name === "H-A");
  assert.equal(a.home_room_id, room.id);
  assert.deepEqual(a.batches.map((b) => [b.name, b.is_whole, b.student_count]), [["ALL", true, 60], ["H1", false, 30], ["H2", false, 30]]);
  assert.deepEqual(divs.find((d) => d.name === "H-B").batches.map((b) => b.name), ["ALL"]);

  // update: new student_count flows into the whole batch; blank home_room keeps the old one
  const upd = await importEntity(api, term.id, "divisions", [{ semester: 3, division: "h-a", student_count: 66, batch: "H1", batch_size: 33 }]);
  assert.equal(upd.status, 200);
  assert.equal(upd.body.rows[0].status, "update");
  const a2 = (await api("GET", `/terms/${term.id}/divisions`)).body.divisions.find((d) => d.name === "H-A");
  assert.equal(a2.student_count, 66);
  assert.equal(a2.home_room_id, room.id);
  assert.equal(a2.batches.find((b) => b.is_whole).student_count, 66);
  assert.equal(a2.batches.find((b) => b.name === "H1").student_count, 33);
  assert.equal(a2.batches.length, 3);

  const bad = await importEntity(api, term.id, "divisions", [
    { semester: 3, division: "H-C", student_count: 10, home_room: "Nowhere / 999" },
    { semester: 3, division: "H-D", student_count: 10, home_room: "no slash" },
    { semester: 3, division: "H-E", student_count: 10, batch: "all", batch_size: 5 },
  ], true);
  assert.equal(bad.body.summary.error, 3);
  assert.ok(bad.body.rows.every((r) => r.errors[0].field === "home_room" || r.errors[0].field === "batch"));
});

test("offerings import: references validated, labs per_batch, batch faculty, repeated rows merge, existing offerings keep faculty not in the file", async () => {
  const term = await makeTerm(api, s);
  const f = (n) => `${s.prefixCode}${n}`;
  await importEntity(api, term.id, "faculty", [{ short_code: f("P"), full_name: "P" }, { short_code: f("Q"), full_name: "Q" }]);
  await importEntity(api, term.id, "subjects", [
    { code: "TH", name: "Theory", kind: "theory", weekly_count: 3 },
    { code: "LB", name: "Lab", kind: "lab", weekly_count: 1 },
  ]);
  await importEntity(api, term.id, "divisions", [
    { semester: 3, division: "O-A", student_count: 30, batch: "O1", batch_size: 15 },
    { semester: 3, division: "O-A", student_count: 30, batch: "O2", batch_size: 15 },
  ]);

  const refs = await importEntity(api, term.id, "offerings", [
    { semester: 3, division: "O-Z", subject_code: "TH", faculty_codes: f("P") },
    { semester: 3, division: "O-A", subject_code: "NOPE", faculty_codes: f("P") },
    { semester: 3, division: "O-A", subject_code: "TH", faculty_codes: "ZZNOBODY" },
    { semester: 3, division: "O-A", subject_code: "LB", faculty_codes: f("P"), batch: "O9" },
  ], true);
  assert.equal(refs.body.summary.error, 4);
  assert.deepEqual(refs.body.rows.map((r) => r.errors[0].field), ["division", "subject_code", "faculty_codes", "batch"]);

  const ok = await importEntity(api, term.id, "offerings", [
    { semester: 3, division: "O-A", subject_code: "TH", faculty_codes: `${f("P")}|${f("Q")}:assist`, weekly_count: 2 },
    { semester: 3, division: "O-A", subject_code: "LB", faculty_codes: f("P"), batch: "O1" },
    { semester: 3, division: "O-A", subject_code: "LB", faculty_codes: `${f("Q")}`, batch: "O2" },
  ]);
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 400));
  assert.deepEqual(ok.body.summary, { total: 3, create: 3, update: 0, error: 0 });
  const offs = (await api("GET", `/terms/${term.id}/offerings`)).body.offerings;
  assert.equal(offs.length, 2, "the two LB rows merged into one offering");
  const lab = offs.find((o) => o.subject.code === "LB");
  const th = offs.find((o) => o.subject.code === "TH");
  assert.equal(lab.per_batch, true);
  assert.equal(th.per_batch, false);
  assert.equal(th.effective_weekly_count, 2);
  assert.deepEqual(th.faculty.map((x) => [x.short_code, x.role, x.batch_id]), [[f("P"), "lead", null], [f("Q"), "assist", null]]);
  const o1 = (await api("GET", `/terms/${term.id}/divisions`)).body.divisions[0].batches.find((b) => b.name === "O1");
  assert.deepEqual(lab.faculty.map((x) => [x.short_code, x.batch_id]).sort(), [[f("P"), o1.id], [f("Q"), lab.faculty.find((x) => x.short_code === f("Q")).batch_id]].sort());

  // a re-import that mentions only one faculty member leaves the other assignment in place (nothing is deleted)
  const re = await importEntity(api, term.id, "offerings", [{ semester: 3, division: "O-A", subject_code: "TH", faculty_codes: f("P") }]);
  assert.equal(re.body.rows[0].status, "update");
  const th2 = (await api("GET", `/terms/${term.id}/offerings`)).body.offerings.find((o) => o.subject.code === "TH");
  assert.equal(th2.faculty.length, 2);
  assert.equal(th2.effective_weekly_count, 2, "blank weekly_count keeps the override");
});

test("body limit: a ~1000-row (>100 KB) import succeeds, a >2 MB body is refused", async () => {
  const term = await makeTerm(api, s);
  const pad = "x".repeat(100); // within the department limit
  const rows = Array.from({ length: 1000 }, (_, i) => ({ short_code: `${s.prefixCode}BL${i}`, full_name: `Body limit ${i}`, department: pad }));
  assert.ok(JSON.stringify({ rows }).length > 100 * 1024, "payload is above the default 100 KB parser limit");
  assert.ok(JSON.stringify({ rows }).length < 2 * 1024 * 1024);
  const res = await importEntity(api, term.id, "faculty", rows);
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  assert.equal(res.body.summary.create, 1000);
  assert.equal(await count("SELECT count(*)::int AS n FROM planner_faculty WHERE short_code LIKE $1", [`${s.prefixCode}BL%`]), 1000);

  const huge = await http("POST", `/planner/terms/${term.id}/import/faculty?dryRun=true`, {
    cookie: sessions.admin.cookie,
    body: { rows: [{ short_code: "H", full_name: "H", department: "y".repeat(2 * 1024 * 1024 + 10) }] },
  });
  assert.equal(huge.status, 413);
});

// ------------------------------------------------------------------ review fixes: limits, keep-stored-values, faculty link

test("import limits: out-of-range numbers and over-long text are row errors in the dry run, and a real run applies nothing", async () => {
  const term = await makeTerm(api, s);
  const subjects = [
    { code: "BIG1", name: "Big weekly", kind: "theory", weekly_count: 5000000 },
    { code: "BIG2", name: "Big total", kind: "theory", weekly_count: 1, semester_total: 99999999999 },
    { code: "BIG3", name: "Big duration", kind: "theory", weekly_count: 1, duration_min: 99999 },
    { code: "x".repeat(5000), name: "Long code", kind: "theory", weekly_count: 1 },
    { code: "OKAY", name: "Fine", kind: "theory", weekly_count: 100, semester_total: 10000 },
  ];
  const dry = await importEntity(api, term.id, "subjects", subjects, true);
  assert.equal(dry.status, 200);
  assert.deepEqual(dry.body.summary, { total: 5, create: 1, update: 0, error: 4 });
  assert.deepEqual(dry.body.rows.map((r) => r.errors.map((e) => e.field)), [["weekly_count"], ["semester_total"], ["duration_min"], ["code"], []]);
  assert.ok(JSON.stringify(dry.body).length < 5000, "the 5000-char value is not echoed back");
  const real = await importEntity(api, term.id, "subjects", subjects);
  assert.equal(real.status, 422);
  assert.equal(real.body.code, "IMPORT_HAS_ERRORS");
  assert.equal(await count("SELECT count(*)::int AS n FROM planner_subjects WHERE term_id = $1", [term.id]), 0);

  const fac = await importEntity(api, term.id, "faculty", [
    { short_code: "y".repeat(5000), full_name: "Long" },
    { short_code: `${s.prefixCode}LimOk`, full_name: "Fine", max_per_day: 100, max_per_week: 1000 },
    { short_code: `${s.prefixCode}LimBad`, full_name: "Bad", max_per_week: 1001 },
  ], true);
  assert.deepEqual(fac.body.rows.map((r) => r.status), ["error", "create", "error"]);

  const div = await importEntity(api, term.id, "divisions", [
    { semester: 3, division: "L-A", student_count: 99999999999 },
    { semester: 3, division: "L-B", student_count: 10, batch: "B1", batch_size: 99999999999 },
    { semester: 3, division: "d".repeat(500), student_count: 10 },
  ], true);
  assert.deepEqual(div.body.rows.map((r) => r.status), ["error", "error", "error"]);

  // the API refuses the same values, so the two entry points cannot drift apart
  const viaApi = await api("POST", `/terms/${term.id}/subjects`, { code: "API", name: "Api", kind: "theory", weekly_count: 101 });
  assert.equal(viaApi.status, 400);
  const viaImport = await importEntity(api, term.id, "subjects", [{ code: "API", name: "Api", kind: "theory", weekly_count: 101 }], true);
  assert.equal(viaImport.body.summary.error, 1);
});

test("re-importing a subjects file without duration_min / allow_second_lab keeps the stored values; new subjects get the defaults", async () => {
  const term = await makeTerm(api, s);
  const first = await importEntity(api, term.id, "subjects", [
    { code: "KS1", name: "Keep theory", kind: "theory", weekly_count: 3 },
    { code: "KS2", name: "Keep lab", kind: "lab", weekly_count: 1 },
  ]);
  assert.equal(first.status, 200);
  const subs = (await api("GET", `/terms/${term.id}/subjects`)).body.subjects;
  const ks1 = subs.find((x) => x.code === "KS1");
  const ks2 = subs.find((x) => x.code === "KS2");
  assert.deepEqual([ks1.duration_min, ks1.allow_second_lab, ks2.duration_min, ks2.allow_second_lab], [60, false, 120, false], "create takes the defaults");

  // customise through the API
  assert.equal((await api("PATCH", `/terms/${term.id}/subjects/${ks1.id}`, { duration_min: 90 })).status, 200);
  assert.equal((await api("PATCH", `/terms/${term.id}/subjects/${ks2.id}`, { duration_min: 90, allow_second_lab: true })).status, 200);

  // a file that lacks (or leaves blank) those columns
  const rows = [
    { code: "KS1", name: "Keep theory (renamed)", kind: "theory", weekly_count: 4 },
    { code: "ks2", name: "Keep lab", kind: "lab", weekly_count: 2, duration_min: "", allow_second_lab: "" },
    { code: "KS3", name: "Brand new lab", kind: "lab", weekly_count: 1 },
  ];
  const dry = await importEntity(api, term.id, "subjects", rows, true);
  assert.deepEqual(dry.body.rows.map((r) => r.status), ["update", "update", "create"]);
  const res = await importEntity(api, term.id, "subjects", rows);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.rows.map((r) => r.status), ["update", "update", "create"], "apply classifies like the dry run");
  const after = (await api("GET", `/terms/${term.id}/subjects`)).body.subjects;
  const pick = (c) => after.find((x) => x.code.toLowerCase() === c);
  assert.deepEqual([pick("ks1").name, pick("ks1").weekly_count, pick("ks1").duration_min, pick("ks1").allow_second_lab], ["Keep theory (renamed)", 4, 90, false]);
  assert.deepEqual([pick("ks2").weekly_count, pick("ks2").duration_min, pick("ks2").allow_second_lab], [2, 90, true], "customised values survive");
  assert.deepEqual([pick("ks3").duration_min, pick("ks3").allow_second_lab], [120, false], "a new subject still gets the term default");

  // explicit values still win
  await importEntity(api, term.id, "subjects", [{ code: "KS1", name: "x", kind: "theory", weekly_count: 4, duration_min: 45, allow_second_lab: "yes" }]);
  const explicit = (await api("GET", `/terms/${term.id}/subjects`)).body.subjects.find((x) => x.code === "KS1");
  assert.deepEqual([explicit.duration_min, explicit.allow_second_lab], [45, true]);
});

test("re-importing divisions with a blank batch_size keeps an existing batch's size; a new batch warns and starts at 0", async () => {
  const term = await makeTerm(api, s);
  const first = await importEntity(api, term.id, "divisions", [
    { semester: 3, division: "BK-A", student_count: 60, batch: "A1", batch_size: 25 },
    { semester: 3, division: "BK-A", student_count: 60, batch: "A2", batch_size: 35 },
  ]);
  assert.equal(first.status, 200);

  const rows = [
    { semester: 3, division: "BK-A", student_count: 60, batch: "A1" },
    { semester: 3, division: "BK-A", student_count: 60, batch: "a2", batch_size: "" },
    { semester: 3, division: "BK-A", student_count: 60, batch: "A3" },
  ];
  const dry = await importEntity(api, term.id, "divisions", rows, true);
  assert.equal(dry.status, 200);
  assert.deepEqual(dry.body.rows.map((r) => r.warnings.length), [0, 0, 1], "only the new batch warns");
  assert.equal(dry.body.rows[2].warnings[0].field, "batch_size");
  const res = await importEntity(api, term.id, "divisions", rows);
  assert.equal(res.status, 200);
  const div = (await api("GET", `/terms/${term.id}/divisions`)).body.divisions.find((d) => d.name === "BK-A");
  assert.deepEqual(div.batches.filter((b) => !b.is_whole).map((b) => [b.name, b.student_count]), [["A1", 25], ["A2", 35], ["A3", 0]]);

  // an explicit size still updates
  await importEntity(api, term.id, "divisions", [{ semester: 3, division: "BK-A", student_count: 60, batch: "A1", batch_size: 30 }]);
  const again = (await api("GET", `/terms/${term.id}/divisions`)).body.divisions.find((d) => d.name === "BK-A");
  assert.equal(again.batches.find((b) => b.name === "A1").student_count, 30);
});

// Needs a Vyas profile email that no other planner test file uses. Set PLANNER_TEST_RELINK_EMAIL to one from your local DB.
const RELINK_EMAIL = process.env.PLANNER_TEST_RELINK_EMAIL;
test("faculty import: an email matching no profile unlinks (like PATCH /faculty); a blank email keeps the stored email and link", { skip: RELINK_EMAIL ? false : "set PLANNER_TEST_RELINK_EMAIL to an existing local profile email" }, async () => {
  const term = await makeTerm(api, s);
  const email = RELINK_EMAIL;
  const { rows: [profile] } = await pool.query("SELECT id FROM profiles WHERE email = $1", [email]);
  assert.ok(profile);
  const code = `${s.prefixCode}Rel`;
  const link = () => pool.query("SELECT profile_id, email FROM planner_faculty WHERE lower(short_code) = lower($1)", [code]).then((r) => r.rows[0]);

  await importEntity(api, term.id, "faculty", [{ short_code: code, full_name: "Relink", email }]);
  assert.deepEqual(await link(), { profile_id: profile.id, email });

  // blank email: stored email and link stay
  const blank = await importEntity(api, term.id, "faculty", [{ short_code: code, full_name: "Relink 2", email: "" }]);
  assert.equal(blank.status, 200);
  assert.deepEqual(await link(), { profile_id: profile.id, email });

  // a new email that matches no profile: unlinked, email updated
  const moved = await importEntity(api, term.id, "faculty", [{ short_code: code, full_name: "Relink 3", email: "nobody-matches-this@mitwpu.edu.in" }]);
  assert.equal(moved.status, 200);
  assert.deepEqual(await link(), { profile_id: null, email: "nobody-matches-this@mitwpu.edu.in" });

  // and back: relinks by the matching email; the same email imported again keeps the link
  await importEntity(api, term.id, "faculty", [{ short_code: code, full_name: "Relink 4", email }]);
  assert.deepEqual(await link(), { profile_id: profile.id, email });
  await importEntity(api, term.id, "faculty", [{ short_code: code, full_name: "Relink 5", email }]);
  assert.deepEqual(await link(), { profile_id: profile.id, email });
});
