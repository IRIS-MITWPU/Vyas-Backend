// database/seed.js
// Run: node database/seed.js
// Inserts sample faculty users, admin, one building, floor, and rooms.
// Safe to re-run — uses ON CONFLICT DO UPDATE / DO NOTHING.

import dotenv from "dotenv";
dotenv.config();

if (process.env.NODE_ENV === "production") {
  console.error("❌ Refusing to seed in production (NODE_ENV=production)");
  process.exit(1);
}

import pool from "./db.js";
import bcrypt from "bcryptjs";

async function seed() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ----------------------------------------------------------
    // Admin user
    // ----------------------------------------------------------
    const adminHash = await bcrypt.hash("Admin@1234", 10);
    const {
      rows: [admin],
    } = await client.query(
      `INSERT INTO profiles (full_name, email, is_admin)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (email)
       DO UPDATE SET full_name = EXCLUDED.full_name, is_admin = TRUE
       RETURNING id`,
      ["Admin User", "admin@mitwpu.edu.in"],
    );

    await client.query(
      `INSERT INTO user_auth (user_id, password_hash)
       VALUES ($1, $2)
       ON CONFLICT (user_id)
       DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [admin.id, adminHash],
    );

    // ----------------------------------------------------------
    // Faculty users
    // ----------------------------------------------------------
    const faculty = [
      { name: "Dr. Ramesh Sharma", email: "ramesh.sharma@mitwpu.edu.in" },
      { name: "Prof. Priya Mehta", email: "priya.mehta@mitwpu.edu.in" },
      { name: "Dr. Ankit Desai", email: "ankit.desai@mitwpu.edu.in" },
    ];

    const facultyHash = await bcrypt.hash("Faculty@123", 10);

    for (const f of faculty) {
      const {
        rows: [u],
      } = await client.query(
        `INSERT INTO profiles (full_name, email)
         VALUES ($1, $2)
         ON CONFLICT (email)
         DO UPDATE SET full_name = EXCLUDED.full_name
         RETURNING id`,
        [f.name, f.email],
      );

      await client.query(
        `INSERT INTO user_auth (user_id, password_hash)
         VALUES ($1, $2)
         ON CONFLICT (user_id)
         DO UPDATE SET password_hash = EXCLUDED.password_hash`,
        [u.id, facultyHash],
      );
    }

    // ----------------------------------------------------------
    // Building
    // ----------------------------------------------------------
    const {
      rows: [building],
    } = await client.query(
      `INSERT INTO buildings (name, description, is_active)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (name)
       DO UPDATE SET description = EXCLUDED.description
       RETURNING id`,
      ["Alpha Building", "Main academic block"],
    );

    // ----------------------------------------------------------
    // Floors (FIXED: ON CONFLICT added)
    // ----------------------------------------------------------
    const {
      rows: [floor1],
    } = await client.query(
      `INSERT INTO floors (building_id, floor_number, name)
       VALUES ($1, 0, 'Ground Floor')
       ON CONFLICT (building_id, floor_number)
       DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [building.id],
    );

    const {
      rows: [floor2],
    } = await client.query(
      `INSERT INTO floors (building_id, floor_number, name)
       VALUES ($1, 1, 'First Floor')
       ON CONFLICT (building_id, floor_number)
       DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [building.id],
    );

    // ----------------------------------------------------------
    // Rooms (FIXED: avoid duplicates manually)
    // ----------------------------------------------------------
    const rooms = [
      {
        name: "Room G01",
        floor_id: floor1.id,
        room_type: "classroom",
        capacity: 60,
      },
      {
        name: "Room G02",
        floor_id: floor1.id,
        room_type: "classroom",
        capacity: 60,
      },
      { name: "Lab G03", floor_id: floor1.id, room_type: "lab", capacity: 30 },
      {
        name: "Room 101",
        floor_id: floor2.id,
        room_type: "classroom",
        capacity: 50,
      },
      {
        name: "Room 102",
        floor_id: floor2.id,
        room_type: "seminar",
        capacity: 25,
      },
    ];

    for (const r of rooms) {
      await client.query(
        `INSERT INTO rooms (name, floor_id, room_type, capacity, is_active)
         SELECT $1, $2, $3, $4, TRUE
         WHERE NOT EXISTS (
           SELECT 1 FROM rooms WHERE name = $1 AND floor_id = $2
         )`,
        [r.name, r.floor_id, r.room_type, r.capacity],
      );
    }

    function getNextWeekday(targetDay) {
      const now = new Date();
      const day = now.getDay(); // 0=Sunday
      let diff = targetDay - day;
      if (diff <= 0) diff += 7;
      const result = new Date(now);
      result.setDate(now.getDate() + diff);
      return result;
    }

    // ----------------------------------------------------------
    // BOOKINGS
    // ----------------------------------------------------------

    // get teachers
    const { rows: teachers } = await client.query(
      `SELECT id, full_name FROM profiles WHERE is_admin = false LIMIT 3`,
    );

    // pick rooms
    const roomList = await client.query(`SELECT id, name FROM rooms LIMIT 3`);

    const nextMonday = getNextWeekday(1); // Monday
    const nextTuesday = getNextWeekday(2);

    // helper to create IST-safe timestamp
    function makeTime(date, hour, minute) {
      const d = new Date(date);
      d.setHours(hour, minute, 0, 0);
      return d;
    }

    const bookingsData = [
      {
        room_id: roomList.rows[0].id,
        teacher_id: teachers[0].id,
        title: "Data Structures Lecture",
        start: makeTime(nextMonday, 10, 0),
        end: makeTime(nextMonday, 11, 0),
      },
      {
        room_id: roomList.rows[1].id,
        teacher_id: teachers[1].id,
        title: "Operating Systems",
        start: makeTime(nextMonday, 11, 30),
        end: makeTime(nextMonday, 12, 30),
      },
      {
        room_id: roomList.rows[2].id,
        teacher_id: teachers[2].id,
        title: "DBMS Practical",
        start: makeTime(nextTuesday, 14, 0),
        end: makeTime(nextTuesday, 15, 30),
      },
    ];

    for (const b of bookingsData) {
      await client.query(
        `INSERT INTO bookings 
     (room_id, teacher_id, title, start_time, end_time, status)
     VALUES ($1, $2, $3, $4, $5, 'confirmed')
     ON CONFLICT DO NOTHING`,
        [b.room_id, b.teacher_id, b.title, b.start, b.end],
      );
    }

    // ----------------------------------------------------------
    // TIMETABLE TEMPLATES
    // ----------------------------------------------------------

    const templates = [
      {
        room_id: roomList.rows[0].id,
        teacher_name: teachers[0].full_name,
        title: "DS Weekly Lecture",
        weekday: 0, // Monday (0 = Monday in schema)
        start_time: "09:00",
        duration: 60,
      },
      {
        room_id: roomList.rows[1].id,
        teacher_name: teachers[1].full_name,
        title: "OS Weekly Lecture",
        weekday: 2, // Wednesday
        start_time: "11:00",
        duration: 60,
      },
    ];

    const templateIds = [];

    for (const t of templates) {
      const {
        rows: [tpl],
      } = await client.query(
        `INSERT INTO room_timetable_templates
     (room_id, teacher_name, title, weekday, start_time, duration_minutes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
        [
          t.room_id,
          t.teacher_name,
          t.title,
          t.weekday,
          t.start_time,
          t.duration,
          teachers[0].id, // creator (admin/teacher)
        ],
      );
      templateIds.push(tpl.id);
    }

    // ----------------------------------------------------------
    // TEMPLATE EXCEPTION
    // ----------------------------------------------------------

    const weekStart = new Date(nextMonday);
    weekStart.setHours(0, 0, 0, 0);

    await client.query(
      `INSERT INTO room_timetable_template_exceptions
   (template_id, week_start_date, reason, created_by)
   VALUES ($1, $2, $3, $4)
   ON CONFLICT (template_id, week_start_date) DO NOTHING`,
      [templateIds[0], weekStart, "Faculty on leave", teachers[0].id],
    );

    await client.query("COMMIT");
    console.log("✅ Database seeded successfully");
    console.log("   Admin    → admin@mitwpu.edu.in  / Admin@1234");
    console.log("   Faculty  → ramesh.sharma@mitwpu.edu.in / Faculty@123");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Seed failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
