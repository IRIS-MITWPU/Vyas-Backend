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
    const { rows: [admin] } = await client.query(
      `INSERT INTO profiles (full_name, email, is_admin)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name, is_admin = TRUE
       RETURNING id`,
      ["Admin User", "admin@mitwpu.edu.in"]
    );
    await client.query(
      `INSERT INTO user_auth (user_id, password_hash) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [admin.id, adminHash]
    );

    // ----------------------------------------------------------
    // Faculty users
    // ----------------------------------------------------------
    const faculty = [
      { name: "Dr. Ramesh Sharma",  email: "ramesh.sharma@mitwpu.edu.in" },
      { name: "Prof. Priya Mehta",  email: "priya.mehta@mitwpu.edu.in"  },
      { name: "Dr. Ankit Desai",    email: "ankit.desai@mitwpu.edu.in"  },
    ];
    const facultyHash = await bcrypt.hash("Faculty@123", 10);

    for (const f of faculty) {
      const { rows: [u] } = await client.query(
        `INSERT INTO profiles (full_name, email)
         VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
         RETURNING id`,
        [f.name, f.email]
      );
      await client.query(
        `INSERT INTO user_auth (user_id, password_hash) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
        [u.id, facultyHash]
      );
    }

    // ----------------------------------------------------------
    // Building
    // ----------------------------------------------------------
    const { rows: [building] } = await client.query(
      `INSERT INTO buildings (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      ["Alpha Building"]
    );

    // ----------------------------------------------------------
    // Floors
    // ----------------------------------------------------------
    const { rows: [floor1] } = await client.query(
      `INSERT INTO floors (building_id, floor_number, name) VALUES ($1, 0, 'Ground Floor')
       RETURNING id`,
      [building.id]
    );
    const { rows: [floor2] } = await client.query(
      `INSERT INTO floors (building_id, floor_number, name) VALUES ($1, 1, 'First Floor')
       RETURNING id`,
      [building.id]
    );

    // ----------------------------------------------------------
    // Rooms
    // ----------------------------------------------------------
    const rooms = [
      { name: "Room G01", floor_id: floor1.id, room_type: "classroom", capacity: 60 },
      { name: "Room G02", floor_id: floor1.id, room_type: "classroom", capacity: 60 },
      { name: "Lab G03",  floor_id: floor1.id, room_type: "lab",       capacity: 30 },
      { name: "Room 101", floor_id: floor2.id, room_type: "classroom", capacity: 50 },
      { name: "Room 102", floor_id: floor2.id, room_type: "seminar",   capacity: 25 },
    ];

    for (const r of rooms) {
      await client.query(
        `INSERT INTO rooms (name, floor_id, room_type, capacity, is_active)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT DO NOTHING`,
        [r.name, r.floor_id, r.room_type, r.capacity]
      );
    }

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
