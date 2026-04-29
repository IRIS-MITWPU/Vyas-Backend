// routes/booking.js
import express from "express";
import pool from "../database/db.js";
import { protect } from "../middlewares/authMiddleware.js";
import redis from "../database/redis.js";

const router = express.Router();

const ROOM_LOCK_KEY = (roomId) => `room:${roomId}:lock`;

// ==============================
// CREATE BOOKING
// ==============================
router.post("/", protect, async (req, res) => {
  const {
    roomId,
    lockToken,
    title,
    description,
    startTime,
    endTime,
    classDivision,
    panel,
    yearCourse,
    isRecurring = false,
  } = req.body;

  const teacherId = req.user.id;

  // ------------------------------
  // Basic validation
  // ------------------------------
  if (!roomId || !lockToken || !title || !startTime || !endTime) {
    return res.status(400).json({
      error: "Missing required booking fields",
    });
  }

  const client = await pool.connect();

  try {
    // ------------------------------
    // 1️⃣ Validate Redis lock
    // ------------------------------
    const rawLock = await redis.get(ROOM_LOCK_KEY(roomId));
    if (!rawLock) {
      return res.status(409).json({ error: "Room is not locked" });
    }

    const lock = JSON.parse(rawLock);

    if (
      lock.token !== lockToken ||
      lock.ownerUserId !== teacherId
    ) {
      return res.status(403).json({
        error: "Lock ownership mismatch",
      });
    }

    // ------------------------------
    // 2️⃣ DB transaction
    // ------------------------------
    await client.query("BEGIN");

    // ------------------------------
    // 3️⃣ Conflict check (time overlap)
    // ------------------------------
    const conflictCheck = await client.query(
      `
      SELECT 1 FROM bookings
      WHERE room_id = $1
        AND tstzrange(start_time, end_time) &&
            tstzrange($2::timestamptz, $3::timestamptz)
      FOR UPDATE
      `,
      [roomId, startTime, endTime]
    );

    if (conflictCheck.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Room already booked for this time slot",
      });
    }

    // ------------------------------
    // 4️⃣ Insert booking
    // ------------------------------
    const bookingResult = await client.query(
      `
      INSERT INTO bookings (
        room_id,
        teacher_id,
        title,
        description,
        start_time,
        end_time,
        class_division,
        panel,
        year_course,
        is_recurring
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
      `,
      [
        roomId,
        teacherId,
        title,
        description || null,
        startTime,
        endTime,
        classDivision || null,
        panel || null,
        yearCourse || null,
        isRecurring,
      ]
    );

    await client.query("COMMIT");

    // ------------------------------
    // 5️⃣ Remove Redis lock
    // ------------------------------
    await redis.del(ROOM_LOCK_KEY(roomId));

    // ------------------------------
    // 6️⃣ Notify clients
    // ------------------------------
    req.app.get("io")?.to(`room:${roomId}`).emit("room:booked", {
      roomId,
      booking: bookingResult.rows[0],
    });

    res.status(201).json({
      success: true,
      booking: bookingResult.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Booking error:", err);
    res.status(500).json({
      error: "Booking failed",
    });
  } finally {
    client.release();
  }
});

export default router;
