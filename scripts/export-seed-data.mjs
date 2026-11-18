// scripts/export-seed-data.mjs
// Run: node scripts/export-seed-data.mjs [--branch=REAL-TEST] [--building=Vyas] [--as-branch=CSE]
//
// READ-ONLY. Exports the Vyas building (floors + rooms) and one Timetable Planner term
// from the database in .env into the JSON files database/seed.js loads:
//   database/seed-data/vyas-building.json
//   database/seed-data/vyas-planner-term.json
//
// Everything is keyed by natural keys (room name, subject code, faculty short_code, division
// semester+name, batch name) - never by UUID - so the files import into any empty database.
// Never exported: users/profiles, allowed_user, sessions, bookings, room templates,
// timetable import data/jobs, generation-run history, occupancy (rebuilt by seed.js).

import dotenv from "dotenv";
dotenv.config();

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run in production (NODE_ENV=production)");
  process.exit(1);
}

import pool from "../database/db.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v];
  }),
);
const SOURCE_BRANCH = args.branch || "REAL-TEST";
const BUILDING = args.building || "Vyas";
const AS_BRANCH = args["as-branch"] || "CSE";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "database", "seed-data");

const omit = (row, keys) => {
  const out = { ...row };
  for (const k of keys) delete out[k];
  return out;
};
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

try {
  const [{ db, port }] = await q("SELECT current_database() AS db, inet_server_port() AS port");
  console.log(`Exporting from database "${db}" on port ${port} (read-only)`);

  // ------------------------------------------------------------------ building
  const [building] = await q("SELECT * FROM buildings WHERE name = $1", [BUILDING]);
  if (!building) throw new Error(`Building "${BUILDING}" not found`);
  const floors = await q("SELECT * FROM floors WHERE building_id = $1 ORDER BY floor_number", [building.id]);
  const rooms = await q(
    `SELECT r.* FROM rooms r JOIN floors f ON f.id = r.floor_id WHERE f.building_id = $1 ORDER BY r.name`,
    [building.id],
  );
  const roomNameById = new Map(rooms.map((r) => [r.id, r.name]));
  if (roomNameById.size !== new Set(rooms.map((r) => r.name)).size) {
    throw new Error("Room names are not unique inside the building - natural keys would collide");
  }
  const buildingJson = {
    name: building.name,
    address: building.address,
    description: building.description,
    is_active: building.is_active,
    floors: floors.map((f) => ({
      floor_number: f.floor_number,
      name: f.name,
      rooms: rooms
        .filter((r) => r.floor_id === f.id)
        .map((r) => omit(r, ["id", "floor_id", "created_at", "updated_at"])),
    })),
  };

  // ------------------------------------------------------------------ planner term
  const [term] = await q(
    `SELECT *, start_date::text AS start_date_t, end_date::text AS end_date_t FROM planner_terms WHERE branch = $1`,
    [SOURCE_BRANCH],
  );
  if (!term) throw new Error(`Planner term with branch "${SOURCE_BRANCH}" not found`);
  if (term.building_id && term.building_id !== building.id) {
    throw new Error("The term is bound to a different building than the one being exported");
  }
  const roomName = (id, what) => {
    if (id === null || id === undefined) return null;
    const n = roomNameById.get(id);
    if (!n) throw new Error(`${what} references a room outside building "${BUILDING}"`);
    return n;
  };

  const termJson = {
    ...omit(term, ["id", "building_id", "created_by", "created_at", "updated_at", "start_date", "end_date", "start_date_t", "end_date_t"]),
    start_date: term.start_date_t,
    end_date: term.end_date_t,
    branch: AS_BRANCH,
    building: BUILDING,
  };

  const poolRooms = (await q("SELECT * FROM planner_term_rooms WHERE term_id = $1", [term.id]))
    .map((r) => ({ room: roomName(r.room_id, "planner_term_rooms"), is_lab: r.is_lab }))
    .sort((a, b) => a.room.localeCompare(b.room));

  const rules = (await q("SELECT * FROM planner_rule_config WHERE term_id = $1 ORDER BY rule_key", [term.id])).map((r) =>
    omit(r, ["id", "term_id"]),
  );

  const subjects = await q("SELECT * FROM planner_subjects WHERE term_id = $1 ORDER BY code", [term.id]);
  const subjectCode = new Map(subjects.map((s) => [s.id, s.code]));

  const divisionsRaw = await q(
    "SELECT * FROM planner_divisions WHERE term_id = $1 ORDER BY semester, name",
    [term.id],
  );
  const divKey = new Map(divisionsRaw.map((d) => [d.id, { semester: d.semester, name: d.name }]));
  const batchesRaw = await q(
    `SELECT b.* FROM planner_batches b JOIN planner_divisions d ON d.id = b.division_id WHERE d.term_id = $1 ORDER BY b.name`,
    [term.id],
  );
  const batchName = new Map(batchesRaw.map((b) => [b.id, b.name]));
  const divisions = divisionsRaw.map((d) => ({
    ...omit(d, ["id", "term_id", "home_room_id", "home_room2_id"]),
    home_room: roomName(d.home_room_id, "home_room"),
    home_room2: roomName(d.home_room2_id, "home_room2"),
    batches: batchesRaw
      .filter((b) => b.division_id === d.id)
      .map((b) => omit(b, ["id", "division_id"])),
  }));

  const offeringsRaw = await q(
    `SELECT o.* FROM planner_offerings o JOIN planner_divisions d ON d.id = o.division_id WHERE d.term_id = $1`,
    [term.id],
  );
  const offeringKey = new Map(offeringsRaw.map((o) => [o.id, o]));
  const faculty = await q(
    `SELECT * FROM planner_faculty
      WHERE id IN (SELECT faculty_id FROM planner_offering_faculty ofa
                     JOIN planner_offerings o ON o.id = ofa.offering_id
                     JOIN planner_divisions d ON d.id = o.division_id WHERE d.term_id = $1)
         OR id IN (SELECT sf.faculty_id FROM planner_session_faculty sf
                     JOIN planner_sessions s ON s.id = sf.session_id
                     JOIN planner_versions v ON v.id = s.version_id WHERE v.term_id = $1)
      ORDER BY short_code`,
    [term.id],
  );
  const facultyCode = new Map(faculty.map((f) => [f.id, f.short_code]));
  const offeringFaculty = await q(
    `SELECT ofa.* FROM planner_offering_faculty ofa
       JOIN planner_offerings o ON o.id = ofa.offering_id
       JOIN planner_divisions d ON d.id = o.division_id WHERE d.term_id = $1`,
    [term.id],
  );
  const offerings = offeringsRaw.map((o) => ({
    division: divKey.get(o.division_id),
    subject: subjectCode.get(o.subject_id),
    ...omit(o, ["id", "division_id", "subject_id"]),
    faculty: offeringFaculty
      .filter((f) => f.offering_id === o.id)
      .map((f) => ({
        batch: f.batch_id ? batchName.get(f.batch_id) : null,
        faculty: facultyCode.get(f.faculty_id),
        role: f.role,
      })),
  }));

  // ------------------------------------------------------------------ the draft version + sessions
  const versions = await q("SELECT * FROM planner_versions WHERE term_id = $1 AND status = 'draft'", [term.id]);
  if (versions.length !== 1) throw new Error("Expected exactly one draft version");
  const [version] = versions;
  const sessionsRaw = await q("SELECT * FROM planner_sessions WHERE version_id = $1 ORDER BY created_at, id", [version.id]);
  const sessionFaculty = await q(
    `SELECT sf.* FROM planner_session_faculty sf JOIN planner_sessions s ON s.id = sf.session_id WHERE s.version_id = $1`,
    [version.id],
  );
  const sharedSessions = new Set(
    (await q("SELECT DISTINCT session_id FROM planner_occupancy WHERE version_id = $1 AND kind = 'lab_room'", [version.id])).map(
      (r) => r.session_id,
    ),
  );
  const sessions = sessionsRaw.map((s) => {
    const o = offeringKey.get(s.offering_id);
    return {
      division: divKey.get(o.division_id),
      subject: subjectCode.get(o.subject_id),
      batch: batchName.get(s.batch_id),
      seq: s.seq,
      weekday: s.weekday,
      start_min: s.start_min,
      end_min: s.end_min,
      room: roomName(s.room_id, "planner_sessions"),
      locked: s.locked,
      shared_room: sharedSessions.has(s.id),
      faculty: sessionFaculty.filter((f) => f.session_id === s.id).map((f) => facultyCode.get(f.faculty_id)).sort(),
    };
  });

  const plannerJson = {
    term: termJson,
    pool_rooms: poolRooms,
    rules,
    faculty: faculty.map((f) => omit(f, ["id", "profile_id", "email", "created_at", "updated_at"])),
    subjects: subjects.map((s) => omit(s, ["id", "term_id"])),
    divisions,
    offerings,
    version: { version_no: version.version_no, status: version.status, rev: Number(version.rev) },
    sessions,
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "vyas-building.json"), JSON.stringify(buildingJson, null, 1) + "\n");
  writeFileSync(path.join(outDir, "vyas-planner-term.json"), JSON.stringify(plannerJson) + "\n");

  console.log(
    `Wrote ${floors.length} floors, ${rooms.length} rooms | ${poolRooms.length} pool rooms, ${rules.length} rules, ` +
      `${faculty.length} faculty, ${subjects.length} subjects, ${divisions.length} divisions, ` +
      `${batchesRaw.length} batches, ${offerings.length} offerings, ${sessions.length} sessions ` +
      `(${sessions.filter((s) => s.weekday !== null).length} placed)`,
  );
} catch (err) {
  console.error("Export failed:", err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
