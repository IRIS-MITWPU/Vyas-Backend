// routes/buildings.js
import express from "express";
import pool from "../database/db.js";
import redis from "../database/redis.js";

const router = express.Router();

const ROOM_LOCK_KEY = (roomId) => `room:${roomId}:lock`;

// GET /building/:name → show building by name
router.get('/:name', async (req, res) => {
  const { name } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM buildings WHERE LOWER(name) = LOWER($1);',
      [name]
    );
    
     

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Building not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching building:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /building/:name/rooms
router.get("/:name/rooms", async (req, res) => {
  const buildingName = req.params.name;
  try {
    // Example: I assume you have a buildings table with name -> id mapping
    const buildingRes = await pool.query("SELECT id FROM buildings WHERE name = $1", [buildingName]);
    if (buildingRes.rows.length === 0) return res.status(404).json({ success: false, message: "Building not found" });
    const buildingId = buildingRes.rows[0].id;

    const roomsRes = await pool.query(
      `SELECT r.id, r.name, r.floor_id, r.room_type, r.capacity, r.equipment, r.is_active, r.created_at, r.updated_at
       FROM rooms r
       JOIN floors f ON r.floor_id = f.id
       WHERE f.building_id = $1
       ORDER BY r.name`,
      [buildingId]
    );

    // add lock info for each room
    const rooms = [];
    for (const row of roomsRes.rows) {
      const lockRaw = await redis.get(ROOM_LOCK_KEY(row.id));
      let lock = null;
      if (lockRaw) {
        try {
          const p = JSON.parse(lockRaw);
          lock = {
            byUserId: p.ownerId,
            createdAt: p.createdAt,
            ttl: p.ttl,
            expiresAt: p.createdAt + p.ttl,
          };
        } catch (e) {
          lock = null;
        }
      }
      rooms.push({ ...row, lock });
    }

    res.json({ success: true, rooms });
  } catch (err) {
    console.error("GET /building/:name/rooms error", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

export default router;





