// database/seed.js
// Run: node database/seed.js
//
// Seeds the REAL Vyas building and the Timetable Planner (editor) data so a fresh
// database is immediately useful:
//   * Vyas building: 5 floors, 53 rooms          (database/seed-data/vyas-building.json)
//   * One planner term (2026-27 / odd / CSE) with its room pool, rules, faculty,
//     divisions, batches, subjects, offerings and a draft timetable
//                                                 (database/seed-data/vyas-planner-term.json)
//   * 4 fixed TEST accounts (1 admin + 3 faculty) that the integration tests rely on.
//
// NOT seeded: real users, allowed_user, sessions, bookings, room templates,
// timetable-import data and import jobs.
//
// The two JSON files are generated from a populated database with
// `node scripts/export-seed-data.mjs` (read-only) - re-run it to refresh them.
//
// Safe to re-run: building/floors/rooms are upserted; the planner term is created once
// and then LEFT UNTOUCHED (so edits made in the editor are never overwritten).

import dotenv from "dotenv";
dotenv.config();

if (process.env.NODE_ENV === "production") {
  console.error("❌ Refusing to seed in production (NODE_ENV=production)");
  process.exit(1);
}

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pool from "./db.js";
import { occupancyRows } from "../services/planner/domain/occupancy.js";

const dataDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "seed-data",
);
const loadJson = (name) =>
  JSON.parse(readFileSync(path.join(dataDir, name), "utf8"));

/**
 * Multi-row INSERT in chunks. `casts` maps column -> SQL type for values that need an
 * explicit cast (jsonb / arrays / enums). Returns the RETURNING rows (insertion order).
 */
async function bulkInsert(
  client,
  table,
  cols,
  rows,
  { casts = {}, returning = null, tail = "", chunk = 400 } = {},
) {
  const out = [];
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params = [];
    const tuples = part.map((row) => {
      const ph = cols.map((c) => {
        params.push(row[c]);
        return `$${params.length}${casts[c] ? `::${casts[c]}` : ""}`;
      });
      return `(${ph.join(", ")})`;
    });
    const sql =
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES ${tuples.join(", ")} ${tail}` +
      (returning ? ` RETURNING ${returning}` : "");
    const res = await client.query(sql, params);
    if (returning) out.push(...res.rows);
  }
  return out;
}

const divKey = (d) => `${d.semester}|${d.name}`;

async function seedBuilding(client) {
  const b = loadJson("vyas-building.json");

  const {
    rows: [building],
  } = await client.query(
    `INSERT INTO buildings (name, address, description, is_active)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (name)
     DO UPDATE SET address = EXCLUDED.address, description = EXCLUDED.description, is_active = EXCLUDED.is_active
     RETURNING id`,
    [b.name, b.address, b.description, b.is_active],
  );

  let roomCount = 0;
  for (const f of b.floors) {
    const {
      rows: [floor],
    } = await client.query(
      `INSERT INTO floors (building_id, floor_number, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (floor_number, building_id)
       DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [building.id, f.floor_number, f.name],
    );

    for (const r of f.rooms) {
      const vals = [
        r.name,
        floor.id,
        r.room_type,
        r.capacity,
        r.equipment ?? null,
        r.is_active,
        r.requires_approval,
      ];
      const upd = await client.query(
        `UPDATE rooms SET room_type = $3::room_type, capacity = $4, equipment = $5::text[],
                          is_active = $6, requires_approval = $7
          WHERE name = $1 AND floor_id = $2`,
        vals,
      );
      if (upd.rowCount === 0) {
        await client.query(
          `INSERT INTO rooms (name, floor_id, room_type, capacity, equipment, is_active, requires_approval)
           VALUES ($1, $2, $3::room_type, $4, $5::text[], $6, $7)`,
          vals,
        );
      }
      roomCount++;
    }
  }
  return {
    buildingId: building.id,
    name: b.name,
    floors: b.floors.length,
    rooms: roomCount,
  };
}

async function seedPlannerTerm(client, buildingId) {
  const data = loadJson("vyas-planner-term.json");
  const t = data.term;

  // The migrations (through 019) must be applied first.
  const {
    rows: [pre],
  } = await client.query(
    `SELECT to_regclass('planner_terms') AS tbl,
            EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'planner_divisions' AND column_name = 'home_room2_id') AS has_019`,
  );
  if (!pre.tbl || !pre.has_019) {
    throw new Error(
      "Planner tables are missing or outdated - run `npm run db:migrate` first",
    );
  }

  const {
    rows: [existing],
  } = await client.query(
    "SELECT id FROM planner_terms WHERE academic_year = $1 AND half = $2 AND branch = $3",
    [t.academic_year, t.half, t.branch],
  );
  if (existing) {
    return { skipped: true, label: `${t.academic_year} ${t.half} ${t.branch}` };
  }

  // Room name -> id (inside the seeded building only)
  const { rows: roomRows } = await client.query(
    `SELECT r.id, r.name FROM rooms r JOIN floors f ON f.id = r.floor_id WHERE f.building_id = $1`,
    [buildingId],
  );
  const roomId = new Map(roomRows.map((r) => [r.name, r.id]));
  const needRoom = (name, what) => {
    if (name === null || name === undefined) return null;
    const id = roomId.get(name);
    if (!id)
      throw new Error(`Seed data refers to unknown room "${name}" (${what})`);
    return id;
  };

  // ---- term
  const {
    rows: [term],
  } = await client.query(
    `INSERT INTO planner_terms
       (academic_year, half, branch, start_date, end_date, working_days, day_start_min, day_end_min,
        grid_minutes, theory_minutes, lab_minutes, breaks, building_id)
     VALUES ($1, $2, $3, $4, $5, $6::smallint[], $7, $8, $9, $10, $11, $12::jsonb, $13)
     RETURNING id`,
    [
      t.academic_year,
      t.half,
      t.branch,
      t.start_date,
      t.end_date,
      t.working_days,
      t.day_start_min,
      t.day_end_min,
      t.grid_minutes,
      t.theory_minutes,
      t.lab_minutes,
      JSON.stringify(t.breaks),
      buildingId,
    ],
  );

  // ---- room pool + rules
  await bulkInsert(
    client,
    "planner_term_rooms",
    ["term_id", "room_id", "is_lab"],
    data.pool_rooms.map((r) => ({
      term_id: term.id,
      room_id: needRoom(r.room, "pool"),
      is_lab: r.is_lab,
    })),
  );
  await bulkInsert(
    client,
    "planner_rule_config",
    ["term_id", "rule_key", "enabled", "severity", "weight", "params"],
    data.rules.map((r) => ({
      ...r,
      term_id: term.id,
      params: JSON.stringify(r.params ?? {}),
    })),
    { casts: { params: "jsonb" } },
  );

  // ---- faculty (global table: keep any that already exist, then map short_code -> id)
  await bulkInsert(
    client,
    "planner_faculty",
    [
      "short_code",
      "full_name",
      "department",
      "max_per_day",
      "max_per_week",
      "is_active",
    ],
    data.faculty,
    { tail: "ON CONFLICT (lower(short_code)) DO NOTHING" },
  );
  const { rows: facRows } = await client.query(
    "SELECT id, lower(short_code) AS code FROM planner_faculty WHERE lower(short_code) = ANY($1::text[])",
    [data.faculty.map((f) => f.short_code.toLowerCase())],
  );
  const facultyId = new Map(facRows.map((f) => [f.code, f.id]));
  const needFaculty = (code) => {
    const id = facultyId.get(String(code).toLowerCase());
    if (!id) throw new Error(`Seed data refers to unknown faculty "${code}"`);
    return id;
  };

  // ---- subjects
  const subjRows = await bulkInsert(
    client,
    "planner_subjects",
    [
      "term_id",
      "code",
      "name",
      "kind",
      "duration_min",
      "weekly_count",
      "semester_total",
      "allow_second_lab",
    ],
    data.subjects.map((s) => ({ ...s, term_id: term.id })),
    { returning: "id, code" },
  );
  const subjectId = new Map(subjRows.map((s) => [s.code, s.id]));

  // ---- divisions + batches
  const divRows = await bulkInsert(
    client,
    "planner_divisions",
    [
      "term_id",
      "semester",
      "name",
      "student_count",
      "home_room_id",
      "home_room2_id",
    ],
    data.divisions.map((d) => ({
      term_id: term.id,
      semester: d.semester,
      name: d.name,
      student_count: d.student_count,
      home_room_id: needRoom(d.home_room, "home_room"),
      home_room2_id: needRoom(d.home_room2, "home_room2"),
    })),
    { returning: "id, semester, name" },
  );
  const divisionId = new Map(divRows.map((d) => [divKey(d), d.id]));

  const batchInput = data.divisions.flatMap((d) =>
    d.batches.map((b) => ({ ...b, division_id: divisionId.get(divKey(d)) })),
  );
  const batchRows = await bulkInsert(
    client,
    "planner_batches",
    ["division_id", "name", "student_count", "is_whole"],
    batchInput,
    { returning: "id, division_id, name, is_whole" },
  );
  const batchId = new Map(
    batchRows.map((b) => [`${b.division_id}|${b.name}`, b.id]),
  );
  const divisionsById = new Map(); // for the occupancy helper
  for (const [id, batches] of Object.entries(
    batchRows.reduce(
      (acc, b) => (
        (acc[b.division_id] ||= []).push({ id: b.id, is_whole: b.is_whole }),
        acc
      ),
      {},
    ),
  )) {
    divisionsById.set(id, { batches });
  }

  // ---- offerings + offering faculty
  const offeringRows = await bulkInsert(
    client,
    "planner_offerings",
    ["division_id", "subject_id", "weekly_count", "per_batch"],
    data.offerings.map((o) => ({
      division_id: divisionId.get(divKey(o.division)),
      subject_id: subjectId.get(o.subject),
      weekly_count: o.weekly_count,
      per_batch: o.per_batch,
    })),
    { returning: "id, division_id, subject_id" },
  );
  const offeringId = new Map(
    offeringRows.map((o) => [`${o.division_id}|${o.subject_id}`, o.id]),
  );

  const offFaculty = [];
  for (const o of data.offerings) {
    const divId = divisionId.get(divKey(o.division));
    const offId = offeringId.get(`${divId}|${subjectId.get(o.subject)}`);
    for (const f of o.faculty) {
      offFaculty.push({
        offering_id: offId,
        batch_id: f.batch ? batchId.get(`${divId}|${f.batch}`) : null,
        faculty_id: needFaculty(f.faculty),
        role: f.role,
      });
    }
  }
  await bulkInsert(
    client,
    "planner_offering_faculty",
    ["offering_id", "batch_id", "faculty_id", "role"],
    offFaculty,
  );

  // ---- draft version + sessions
  const {
    rows: [version],
  } = await client.query(
    `INSERT INTO planner_versions (term_id, version_no, status, rev) VALUES ($1, $2, $3, $4) RETURNING id`,
    [term.id, data.version.version_no, data.version.status, data.version.rev],
  );

  const sessionInput = data.sessions.map((s) => {
    const divId = divisionId.get(divKey(s.division));
    return {
      version_id: version.id,
      offering_id: offeringId.get(`${divId}|${subjectId.get(s.subject)}`),
      batch_id: batchId.get(`${divId}|${s.batch}`),
      seq: s.seq,
      weekday: s.weekday,
      start_min: s.start_min,
      end_min: s.end_min,
      room_id: needRoom(s.room, "session"),
      locked: s.locked,
      _division_id: divId,
      _faculty: s.faculty,
      _shared: s.shared_room,
    };
  });
  const sessRows = await bulkInsert(
    client,
    "planner_sessions",
    [
      "version_id",
      "offering_id",
      "batch_id",
      "seq",
      "weekday",
      "start_min",
      "end_min",
      "room_id",
      "locked",
    ],
    sessionInput,
    { returning: "id, offering_id, batch_id, seq" },
  );
  const sessionId = new Map(
    sessRows.map((s) => [`${s.offering_id}|${s.batch_id}|${s.seq}`, s.id]),
  );

  const sessFaculty = [];
  const occ = {
    kind: [],
    resource_id: [],
    session_id: [],
    weekday: [],
    start_min: [],
    end_min: [],
  };
  for (const s of sessionInput) {
    const id = sessionId.get(`${s.offering_id}|${s.batch_id}|${s.seq}`);
    const facultyIds = s._faculty.map(needFaculty);
    for (const fid of facultyIds)
      sessFaculty.push({ session_id: id, faculty_id: fid });

    // planner_occupancy is derived data: rebuild it exactly the way the editor does
    for (const r of occupancyRows({
      session: { ...s, faculty_ids: facultyIds, shared_room: s._shared },
      division: divisionsById.get(s._division_id),
    })) {
      occ.kind.push(r.kind);
      occ.resource_id.push(r.resource_id);
      occ.session_id.push(id);
      occ.weekday.push(r.weekday);
      occ.start_min.push(r.start_min);
      occ.end_min.push(r.end_min);
    }
  }
  await bulkInsert(
    client,
    "planner_session_faculty",
    ["session_id", "faculty_id"],
    sessFaculty,
  );
  if (occ.kind.length) {
    await client.query(
      `INSERT INTO planner_occupancy (version_id, session_id, kind, resource_id, weekday, during)
       SELECT $1, t.session_id, t.kind, t.resource_id, t.weekday, int4range(t.start_min, t.end_min, '[)')
         FROM unnest($2::text[], $3::uuid[], $4::uuid[], $5::int[], $6::int[], $7::int[])
              AS t(kind, resource_id, session_id, weekday, start_min, end_min)`,
      [
        version.id,
        occ.kind,
        occ.resource_id,
        occ.session_id,
        occ.weekday,
        occ.start_min,
        occ.end_min,
      ],
    );
  }

  return {
    skipped: false,
    label: `${t.academic_year} ${t.half} ${t.branch}`,
    faculty: data.faculty.length,
    subjects: data.subjects.length,
    divisions: data.divisions.length,
    batches: batchRows.length,
    offerings: data.offerings.length,
    sessions: sessRows.length,
    placed: sessionInput.filter((s) => s.weekday !== null).length,
    occupancy: occ.kind.length,
  };
}

// ----------------------------------------------------------------------
// TEST ACCOUNTS - the integration tests (tests/**) sign in as these, so they
// must exist. They are the only user rows the seed creates.
// ----------------------------------------------------------------------
const TEST_ADMIN = [
  { name: "Admin User", email: "admin@mitwpu.edu.in" },
  { name: "Arnav Dev", email: "1272261266.a@mitwpu.edu.in" },
  { name: "Aditya Mahamuni", email: "aditya.mahamuni1@mitwpu.edu.in" },
];
const TEST_FACULTY = [
  { name: "Dr. Ramesh Sharma", email: "ramesh.sharma@mitwpu.edu.in" },
  { name: "Prof. Priya Mehta", email: "priya.mehta@mitwpu.edu.in" },
  { name: "Dr. Ankit Desai", email: "ankit.desai@mitwpu.edu.in" },
];

async function seedTestAccounts(client) {
  for (const a of TEST_ADMIN) {
    await client.query(
      `INSERT INTO profiles (full_name, email, is_admin, email_verified)
       VALUES ($1, $2, TRUE, TRUE)
       ON CONFLICT (email)
       DO UPDATE SET full_name = EXCLUDED.full_name, is_admin = TRUE, email_verified = TRUE`,
      [a.name, a.email],
    );
  }
  for (const f of TEST_FACULTY) {
    await client.query(
      `INSERT INTO profiles (full_name, email, email_verified)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (email)
       DO UPDATE SET full_name = EXCLUDED.full_name, email_verified = TRUE`,
      [f.name, f.email],
    );
  }
}

async function seed() {
  const client = await pool.connect();
  try {
    const {
      rows: [target],
    } = await client.query(
      "SELECT current_database() AS db, inet_server_port() AS port",
    );
    console.log(`Seeding database "${target.db}" on port ${target.port}`);

    await client.query("BEGIN");

    const building = await seedBuilding(client);
    const planner = await seedPlannerTerm(client, building.buildingId);
    await seedTestAccounts(client);

    await client.query("COMMIT");

    console.log("✅ Database seeded successfully");
    console.log(
      `   Building → ${building.name}: ${building.floors} floors, ${building.rooms} rooms`,
    );
    if (planner.skipped) {
      console.log(
        `   Planner  → term ${planner.label} already exists - left untouched`,
      );
    } else {
      console.log(
        `   Planner  → term ${planner.label}: ${planner.divisions} divisions, ${planner.batches} batches, ` +
          `${planner.subjects} subjects, ${planner.offerings} offerings, ${planner.faculty} faculty, ` +
          `${planner.sessions} sessions (${planner.placed} placed), ${planner.occupancy} occupancy rows`,
      );
    }
    console.log(
      `   Test accounts → ${TEST_ADMIN.email} (admin), ${TEST_FACULTY.map((f) => f.email).join(", ")}`,
    );
    console.log(
      "   Sign in with an emailed code; real admins: `npm run create-admin` (env ADMIN_EMAIL).",
    );
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Seed failed:", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
