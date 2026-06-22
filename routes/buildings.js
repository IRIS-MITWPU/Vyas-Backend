import express from "express";
import pool from "../database/db.js";
import { adminOnly, protect } from "../middlewares/authMiddleware.js";

const router = express.Router();

// ==============================
// GET /buildings → list all active buildings
// ==============================
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM buildings WHERE is_active = true ORDER BY name"
    );
    res.json({ success: true, buildings: result.rows });
  } catch (error) {
    console.error("Error listing buildings:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ==============================
// GET /buildings/all-floors → all floors (admin)
// ==============================
router.get("/all-floors", protect, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT f.*, f.floor_number AS number, b.name AS building_name, b.id AS building_id_ref
       FROM floors f
       JOIN buildings b ON f.building_id = b.id
       ORDER BY b.name, f.floor_number`
    );
    res.json({ success: true, floors: result.rows });
  } catch (error) {
    console.error("Error listing floors:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ==============================
// GET /buildings/all-rooms → all rooms (admin)
// ==============================
router.get("/all-rooms", protect, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, f.floor_number, f.floor_number AS number, f.name AS floor_name, b.name AS building_name
       FROM rooms r
       JOIN floors f ON r.floor_id = f.id
       JOIN buildings b ON f.building_id = b.id
       ORDER BY b.name, f.floor_number, r.name`
    );
    res.json({ success: true, rooms: result.rows });
  } catch (error) {
    console.error("Error listing rooms:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ==============================
// GET /buildings/:id/floors → floors with nested rooms for a building (by ID)
// ==============================
router.get("/:id/floors", async (req, res) => {
  try {
    const buildingRes = await pool.query(
      "SELECT * FROM buildings WHERE id = $1",
      [req.params.id]
    );
    if (buildingRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Building not found" });
    }
    const building = buildingRes.rows[0];

    // Single LEFT JOIN instead of one rooms query per floor (was N+1).
    const rowsRes = await pool.query(
      `SELECT
         f.id AS floor_id, f.building_id, f.floor_number, f.name AS floor_name,
         f.created_at AS floor_created_at, f.updated_at AS floor_updated_at,
         r.id AS room_id, r.name AS room_name, r.floor_id AS room_floor_id,
         r.room_type, r.capacity, r.equipment, r.is_active, r.requires_approval,
         r.created_at AS room_created_at, r.updated_at AS room_updated_at
       FROM floors f
       LEFT JOIN rooms r ON r.floor_id = f.id
       WHERE f.building_id = $1
       ORDER BY f.floor_number, r.name`,
      [req.params.id]
    );

    const floorsById = new Map();
    for (const row of rowsRes.rows) {
      if (!floorsById.has(row.floor_id)) {
        floorsById.set(row.floor_id, {
          id: row.floor_id,
          building_id: row.building_id,
          floor_number: row.floor_number,
          number: row.floor_number,
          name: row.floor_name,
          created_at: row.floor_created_at,
          updated_at: row.floor_updated_at,
          rooms: [],
          building,
        });
      }
      if (row.room_id) {
        floorsById.get(row.floor_id).rooms.push({
          id: row.room_id,
          name: row.room_name,
          floor_id: row.room_floor_id,
          room_type: row.room_type,
          capacity: row.capacity,
          equipment: row.equipment,
          is_active: row.is_active,
          requires_approval: row.requires_approval,
          created_at: row.room_created_at,
          updated_at: row.room_updated_at,
        });
      }
    }

    res.json({ success: true, floors: [...floorsById.values()] });
  } catch (error) {
    console.error("Error fetching building floors:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// GET /buildings/:name/rooms → get all room in a specified building
router.get("/:name/rooms", async (req, res) => {
  const buildingName = req.params.name;
  try {
    // Example: I assume you have a buildings table with name -> id mapping
    const buildingRes = await pool.query(
      "SELECT id FROM buildings WHERE name = $1",
      [buildingName],
    );
    if (buildingRes.rows.length === 0)
      return res
        .status(404)
        .json({ success: false, message: "Building not found" });
    const buildingId = buildingRes.rows[0].id;

    const roomsRes = await pool.query(
      `SELECT r.id, r.name, r.floor_id, r.room_type, r.capacity, r.equipment, r.is_active, r.created_at, r.updated_at
       FROM rooms r
       JOIN floors f ON r.floor_id = f.id
       WHERE f.building_id = $1
       ORDER BY r.name`,
      [buildingId],
    );

    res.json({ success: true, rooms: roomsRes.rows });
  } catch (err) {
    console.error("GET /building/:name/rooms error", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// GET /buildings/:name → show building by name
router.get("/:name", async (req, res) => {
  const { name } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM buildings WHERE LOWER(name) = LOWER($1);",
      [name],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Building not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching building:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /buildings → create new building
router.post("/", protect, adminOnly, async (req, res) => {
  const { name, address, description } = req.body;
  const timestamp = new Date().toISOString();

  if (!name?.trim() || !address?.trim() || !description?.trim()) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields",
    });
  }

  const client = await pool.connect();

  try {
    const result = await client.query(
      `
      INSERT INTO buildings (
        name,
        address,
        description,
        is_active,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [name.trim(), address.trim(), description.trim(), true, timestamp, timestamp],
    );

    return res.status(201).json({
      success: true,
      building: result.rows[0],
    });
  } catch (error) {
    console.error("Error creating building:", error);

    // Duplicate building name
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        error: "Building name already exists",
      });
    }

    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  } finally {
    client.release();
  }
});

// DELETE /buildings/:id → delete building (admin only)
router.delete("/:id", protect, adminOnly, async (req, res) => {
  const { id } = req.params;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Check if building exists
    const buildingRes = await client.query(
      "SELECT * FROM buildings WHERE id = $1",
      [id],
    );

    if (buildingRes.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        error: "Building not found",
      });
    }

    // Optional: prevent delete if building has floors/rooms
    const floorsRes = await client.query(
      "SELECT id FROM floors WHERE building_id = $1 LIMIT 1",
      [id],
    );

    if (floorsRes.rows.length > 0) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        error:
          "Cannot delete building because it still contains floors/rooms",
      });
    }

    // Delete building
    await client.query("DELETE FROM buildings WHERE id = $1", [id]);

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Building deleted successfully",
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Error deleting building:", error);

    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  } finally {
    client.release();
  }
});

// PUT /buildings/:id → update building (admin only)
router.put("/:id", protect, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { name, address, description, is_active } = req.body;

  const client = await pool.connect();

  try {
    // Check if building exists
    const existingRes = await client.query(
      "SELECT * FROM buildings WHERE id = $1",
      [id],
    );

    if (existingRes.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Building not found",
      });
    }

    const existingBuilding = existingRes.rows[0];

    // Use existing values if fields are not provided
    const updatedName = name?.trim() || existingBuilding.name;
    const updatedAddress = address?.trim() || existingBuilding.address;
    const updatedDescription =
      description?.trim() || existingBuilding.description;

    const updatedIsActive =
      typeof is_active === "boolean"
        ? is_active
        : existingBuilding.is_active;

    const updatedAt = new Date().toISOString();

    const updateRes = await client.query(
      `
      UPDATE buildings
      SET
        name = $1,
        address = $2,
        description = $3,
        is_active = $4,
        updated_at = $5
      WHERE id = $6
      RETURNING *
      `,
      [
        updatedName,
        updatedAddress,
        updatedDescription,
        updatedIsActive,
        updatedAt,
        id,
      ],
    );

    return res.json({
      success: true,
      building: updateRes.rows[0],
    });
  } catch (error) {
    console.error("Error updating building:", error);

    // Duplicate building name
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        error: "Building name already exists",
      });
    }

    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  } finally {
    client.release();
  }
});

// POST /buildings/:id/floor → create floor
router.post("/:id/floor", protect, adminOnly, async (req, res) => {
  const { id: buildingId } = req.params;
  const { floor_number, name } = req.body;

  // Validation
  if (floor_number === undefined || floor_number === null) {
    return res.status(400).json({
      success: false,
      error: "floor_number is required",
    });
  }

  const client = await pool.connect();

  try {
    // Check if building exists
    const buildingRes = await client.query(
      "SELECT id FROM buildings WHERE id = $1",
      [buildingId],
    );

    if (buildingRes.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Building not found",
      });
    }

    const timestamp = new Date().toISOString();

    // Create floor
    const floorRes = await client.query(
      `
      INSERT INTO floors (
        building_id,
        floor_number,
        name,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [
        buildingId,
        floor_number,
        name?.trim() || null,
        timestamp,
        timestamp,
      ],
    );

    return res.status(201).json({
      success: true,
      floor: floorRes.rows[0],
    });
  } catch (error) {
    console.error("Error creating floor:", error);

    // Duplicate floor number in same building
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        error: "Floor number already exists in this building",
      });
    }

    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  } finally {
    client.release();
  }
});

// DELETE /buildings/floor/:id → delete floor by id
router.delete("/floor/:id", protect, adminOnly, async (req, res) => {
  const { id } = req.params;

  const client = await pool.connect();

  try {
    // Check if floor exists
    const floorRes = await client.query(
      "SELECT * FROM floors WHERE id = $1",
      [id],
    );

    if (floorRes.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Floor not found",
      });
    }

    // Optional: prevent deleting floor if rooms exist
    const roomsRes = await client.query(
      "SELECT id FROM rooms WHERE floor_id = $1 LIMIT 1",
      [id],
    );

    if (roomsRes.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: "Cannot delete floor because it contains rooms",
      });
    }

    // Delete floor
    await client.query("DELETE FROM floors WHERE id = $1", [id]);

    return res.json({
      success: true,
      message: "Floor deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting floor:", error);

    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  } finally {
    client.release();
  }
});

// PUT /buildings/floor/:id → update floor
router.put("/floor/:id", protect, adminOnly, async (req, res) => {
  const { id } = req.params;

  const floor_number = req.body?.floor_number;
  const name = req.body?.name;
  const building_id = req.body?.building_id;

  const client = await pool.connect();

  try {
    // Check if floor exists
    const floorRes = await client.query(
      "SELECT * FROM floors WHERE id = $1",
      [id],
    );

    if (floorRes.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Floor not found",
      });
    }

    const existingFloor = floorRes.rows[0];

    if (building_id !== undefined && building_id !== existingFloor.building_id) {
      const targetBuildingRes = await client.query(
        "SELECT id FROM buildings WHERE id = $1",
        [building_id],
      );
      if (targetBuildingRes.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "Target building not found",
        });
      }
    }

    // Keep old values if not provided
    const updatedFloorNumber =
      floor_number !== undefined
        ? floor_number
        : existingFloor.floor_number;

    const updatedName =
      name !== undefined
        ? name?.trim() || null
        : existingFloor.name;

    const updatedBuildingId =
      building_id !== undefined ? building_id : existingFloor.building_id;

    const updatedAt = new Date().toISOString();

    // Update floor
    const updateRes = await client.query(
      `
      UPDATE floors
      SET
        floor_number = $1,
        name = $2,
        building_id = $3,
        updated_at = $4
      WHERE id = $5
      RETURNING *
      `,
      [
        updatedFloorNumber,
        updatedName,
        updatedBuildingId,
        updatedAt,
        id,
      ],
    );

    return res.json({
      success: true,
      floor: updateRes.rows[0],
    });
  } catch (error) {
    console.error("Error updating floor:", error);

    // UNIQUE (floor_number, building_id)
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        error: "Floor number already exists in this building",
      });
    }

    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  } finally {
    client.release();
  }
});

// POST /floor/:id/room → create room
router.post("/floor/:id/room", protect, adminOnly, async (req, res) => {
  const { id: floorId } = req.params;

  const {
    name,
    room_type,
    capacity,
    equipment,
    is_active,
    requires_approval,
  } = req.body || {};

  // Validation
  if (!name?.trim()) {
    return res.status(400).json({
      success: false,
      error: "Room name is required",
    });
  }

  if (!room_type) {
    return res.status(400).json({
      success: false,
      error: "room_type is required",
    });
  }

  const client = await pool.connect();

  try {
    // Check if floor exists
    const floorRes = await client.query(
      "SELECT * FROM floors WHERE id = $1",
      [floorId],
    );

    if (floorRes.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Floor not found",
      });
    }

    const timestamp = new Date().toISOString();

    // Create room
    const roomRes = await client.query(
      `
      INSERT INTO rooms (
        name,
        floor_id,
        room_type,
        capacity,
        equipment,
        is_active,
        requires_approval,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
      `,
      [
        name.trim(),
        floorId,
        room_type,
        capacity || null,
        Array.isArray(equipment) ? equipment : [],
        typeof is_active === "boolean" ? is_active : true,
        typeof requires_approval === "boolean"
          ? requires_approval
          : false,
        timestamp,
        timestamp,
      ],
    );

    return res.status(201).json({
      success: true,
      room: roomRes.rows[0],
    });
  } catch (error) {
    console.error("Error creating room:", error);

    // Invalid enum value for room_type
    if (error.code === "22P02") {
      return res.status(400).json({
        success: false,
        error: "Invalid room_type value",
      });
    }

    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  } finally {
    client.release();
  }
});

// PUT /room/:id → update room
router.put("/room/:id", protect, adminOnly, async (req, res) => {
  const { id } = req.params;

  const {
    name,
    room_type,
    capacity,
    equipment,
    is_active,
    requires_approval,
    floor_id,
  } = req.body || {};

  const client = await pool.connect();

  try {
    // Check if room exists
    const roomRes = await client.query(
      "SELECT * FROM rooms WHERE id = $1",
      [id],
    );

    if (roomRes.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Room not found",
      });
    }

    const existingRoom = roomRes.rows[0];

    if (floor_id !== undefined && floor_id !== existingRoom.floor_id) {
      const targetFloorRes = await client.query(
        "SELECT id FROM floors WHERE id = $1",
        [floor_id],
      );
      if (targetFloorRes.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "Target floor not found",
        });
      }
    }

    // Keep old values if fields are not provided
    const updatedName =
      name !== undefined
        ? name.trim()
        : existingRoom.name;

    const updatedRoomType =
      room_type !== undefined
        ? room_type
        : existingRoom.room_type;

    const updatedCapacity =
      capacity !== undefined
        ? capacity
        : existingRoom.capacity;

    const updatedEquipment =
      equipment !== undefined
        ? (Array.isArray(equipment) ? equipment : [])
        : existingRoom.equipment;

    const updatedIsActive =
      typeof is_active === "boolean"
        ? is_active
        : existingRoom.is_active;

    const updatedRequiresApproval =
      typeof requires_approval === "boolean"
        ? requires_approval
        : existingRoom.requires_approval;

    const updatedFloorId =
      floor_id !== undefined ? floor_id : existingRoom.floor_id;

    const updatedAt = new Date().toISOString();

    // Update room
    const updateRes = await client.query(
      `
      UPDATE rooms
      SET
        name = $1,
        room_type = $2,
        capacity = $3,
        equipment = $4,
        is_active = $5,
        requires_approval = $6,
        floor_id = $7,
        updated_at = $8
      WHERE id = $9
      RETURNING *
      `,
      [
        updatedName,
        updatedRoomType,
        updatedCapacity,
        updatedEquipment,
        updatedIsActive,
        updatedRequiresApproval,
        updatedFloorId,
        updatedAt,
        id,
      ],
    );

    return res.json({
      success: true,
      room: updateRes.rows[0],
    });
  } catch (error) {
    console.error("Error updating room:", error);

    // Invalid enum value
    if (error.code === "22P02") {
      return res.status(400).json({
        success: false,
        error: "Invalid room_type value",
      });
    }

    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  } finally {
    client.release();
  }
});

// DELETE /room/:id → delete room
router.delete("/room/:id", protect, adminOnly, async (req, res) => {
  const { id } = req.params;

  const client = await pool.connect();

  try {
    // Check if room exists
    const roomRes = await client.query(
      "SELECT * FROM rooms WHERE id = $1",
      [id],
    );

    if (roomRes.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Room not found",
      });
    }

    // Prevent deleting a room with active bookings — rooms.id cascades to
    // bookings, so without this check the DELETE below would silently wipe
    // booking history. Cancelled/denied bookings don't block deletion,
    // matching the exclusion constraint's own definition of "active".
    const bookingsRes = await client.query(
      "SELECT id FROM bookings WHERE room_id = $1 AND status NOT IN ('cancelled', 'denied') LIMIT 1",
      [id],
    );

    if (bookingsRes.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: "Cannot delete room because it has active bookings",
      });
    }

    // Delete room
    await client.query(
      "DELETE FROM rooms WHERE id = $1",
      [id],
    );

    return res.json({
      success: true,
      message: "Room deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting room:", error);

    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  } finally {
    client.release();
  }
});

// Will shift this to rooms.js later
// GET /rooms/free?date=&startTime=&endTime=
router.get("/rooms/free", protect, async (req, res) => {
  const { date, startTime, endTime } = req.query;

  // Validation
  if (!date || !startTime || !endTime) {
    return res.status(400).json({
      success: false,
      error: "date, startTime and endTime are required",
    });
  }

  // Build timestamps
  const start = new Date(`${date}T${startTime}:00`);
  const end = new Date(`${date}T${endTime}:00`);

  // Validate dates
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return res.status(400).json({
      success: false,
      error: "Invalid date/time format",
    });
  }

  if (end <= start) {
    return res.status(400).json({
      success: false,
      error: "endTime must be after startTime",
    });
  }

  try {
    const roomsRes = await pool.query(
      `
      SELECT
        r.id,
        r.name,
        r.floor_id,
        r.room_type,
        r.capacity,
        r.equipment,
        r.is_active,
        r.requires_approval,
        r.created_at,
        r.updated_at,
        f.name AS floor_name,
        f.floor_number,
        b.name AS building_name
      FROM rooms r
      JOIN floors f ON r.floor_id = f.id
      JOIN buildings b ON f.building_id = b.id
      WHERE r.is_active = true
      AND NOT EXISTS (
        SELECT 1
        FROM bookings bk
        WHERE bk.room_id = r.id
        AND tstzrange(bk.start_time, bk.end_time, '[)')
            &&
            tstzrange($1::timestamptz, $2::timestamptz, '[)')
      )
      ORDER BY r.name
      `,
      [start.toISOString(), end.toISOString()],
    );

    return res.json({
      success: true,
      count: roomsRes.rows.length,
      rooms: roomsRes.rows,
    });
  } catch (error) {
    console.error("GET /rooms/free error", error);

    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});
export default router;
