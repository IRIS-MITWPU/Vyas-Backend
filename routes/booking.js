// routes/booking.js (FIXED VERSION)
import express from "express";
import pool from "../database/db.js";
import { protect, adminOnly } from "../middlewares/authMiddleware.js";
import redis from "../database/redis.js";
import { sendBookingConfirmationEmail } from "../services/emailService.js";

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

  if (!roomId || !lockToken || !title || !startTime || !endTime) {
    return res.status(400).json({
      error: "Missing required booking fields",
    });
  }

  const client = await pool.connect();

  try {
    const rawLock = await redis.get(ROOM_LOCK_KEY(roomId));
    if (!rawLock) {
      return res.status(409).json({ error: "Room is not locked" });
    }

    const lock = JSON.parse(rawLock);

    if (lock.token !== lockToken || lock.ownerUserId !== teacherId) {
      return res.status(403).json({
        error: "Lock ownership mismatch",
      });
    }

    await client.query("BEGIN");

    const conflictCheck = await client.query(
      `
      SELECT 1 FROM bookings
      WHERE room_id = $1
      AND status NOT IN ('cancelled', 'denied')
      AND tstzrange(start_time, end_time) &&
          tstzrange($2::timestamptz, $3::timestamptz)
      FOR UPDATE
      `,
      [roomId, startTime, endTime],
    );

    if (conflictCheck.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Room already booked for this time slot",
      });
    }

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
      ],
    );

    const detailsResult = await client.query(
      `
      SELECT p.full_name, p.email, r.name AS room_name
      FROM profiles p
      JOIN rooms r ON r.id = $1
      WHERE p.id = $2
      `,
      [roomId, teacherId],
    );

    const details = detailsResult.rows[0];

    await client.query("COMMIT");
    await redis.del(ROOM_LOCK_KEY(roomId));

    sendBookingConfirmationEmail({
      to: details.email,
      fullName: details.full_name,
      roomName: details.room_name,
      title,
      description,
      startTime,
      endTime,
      classDivision,
      panel,
      yearCourse,
    }).catch((err) => {
      console.error("Booking email failed:", err);
    });

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
      details: err.message
    });
  } finally {
    client.release();
  }
});

// ==============================
// GET AUTHENTICATED USER'S BOOKINGS (FIXED)
// ==============================
router.get("/my", protect, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Check if rooms table has 'location' column, if not, remove it
    const result = await pool.query(
      `
      SELECT 
        b.*,
        r.name as room_name
      FROM bookings b
      JOIN rooms r ON b.room_id = r.id
      WHERE b.teacher_id = $1
      ORDER BY b.start_time DESC
      `,
      [userId]
    );
    
    const now = new Date();
    const upcoming = result.rows.filter(booking => 
      new Date(booking.start_time) > now
    );
    const past = result.rows.filter(booking => 
      new Date(booking.start_time) <= now
    );
    
    res.status(200).json({
      success: true,
      upcoming,
      past,
      total: result.rows.length
    });
  } catch (err) {
    console.error("Error fetching user bookings:", err);
    res.status(500).json({ 
      error: "Failed to fetch bookings",
      details: err.message 
    });
  }
});

// ==============================
// GET SINGLE BOOKING DETAILS (FIXED)
// ==============================
router.get("/:id", protect, async (req, res) => {
  try {
    const bookingId = req.params.id;
    const userId = req.user.id;
    const isAdmin = req.user.is_admin;
    
    const result = await pool.query(
      `
      SELECT 
        b.*,
        r.name as room_name
      FROM bookings b
      JOIN rooms r ON b.room_id = r.id
      WHERE b.id = $1
      `,
      [bookingId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Booking not found" });
    }
    
    const booking = result.rows[0];
    
    if (booking.teacher_id !== userId && !isAdmin) {
      return res.status(403).json({ error: "Access denied" });
    }
    
    res.status(200).json({
      success: true,
      booking
    });
  } catch (err) {
    console.error("Error fetching booking details:", err);
    res.status(500).json({ 
      error: "Failed to fetch booking details",
      details: err.message 
    });
  }
});

// ==============================
// CANCEL BOOKING (FIXED)
// ==============================
router.delete("/:id", protect, async (req, res) => {
  const bookingId = req.params.id;
  const userId = req.user.id;
  const isAdmin = req.user.is_admin;
  
  const client = await pool.connect();
  
  try {
    await client.query("BEGIN");
    
    const bookingResult = await client.query(
      `
      SELECT b.*, r.name as room_name
      FROM bookings b
      JOIN rooms r ON b.room_id = r.id
      WHERE b.id = $1
      FOR UPDATE
      `,
      [bookingId]
    );
    
    if (bookingResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Booking not found" });
    }
    
    const booking = bookingResult.rows[0];
    
    if (booking.teacher_id !== userId && !isAdmin) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Access denied" });
    }
    
    if (booking.status === 'cancelled') {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Booking already cancelled" });
    }
    
    const updateResult = await client.query(
      `
      UPDATE bookings
      SET status = 'cancelled'
      WHERE id = $1
      RETURNING *
      `,
      [bookingId]
    );
    
    await client.query("COMMIT");
    
    req.app.get("io")?.to(`room:${booking.room_id}`).emit("booking:cancelled", {
      bookingId,
      roomId: booking.room_id,
      cancelledBy: isAdmin ? 'admin' : 'user',
      cancelledAt: new Date()
    });
    
    res.status(200).json({
      success: true,
      message: "Booking cancelled successfully",
      booking: updateResult.rows[0]
    });
    
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error cancelling booking:", err);
    res.status(500).json({ 
      error: "Failed to cancel booking",
      details: err.message 
    });
  } finally {
    client.release();
  }
});

// ==============================
// ADMIN: GET ALL BOOKINGS WITH FILTERS (FIXED)
// ==============================
router.get("/admin/all", protect, adminOnly, async (req, res) => {
  try {
    const { date, room, status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    
    let query = `
      SELECT 
        b.*,
        r.name as room_name,
        p.full_name as teacher_name,
        p.email as teacher_email
      FROM bookings b
      JOIN rooms r ON b.room_id = r.id
      JOIN profiles p ON b.teacher_id = p.id
      WHERE 1=1
    `;
    
    const params = [];
    let paramIndex = 1;
    
    if (date) {
      query += ` AND DATE(b.start_time) = $${paramIndex}`;
      params.push(date);
      paramIndex++;
    }
    
    if (room) {
      query += ` AND b.room_id = $${paramIndex}`;
      params.push(room);
      paramIndex++;
    }
    
    if (status && status !== 'all') {
      query += ` AND b.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }
    
    const countQuery = query.replace(
      /SELECT.*FROM/,
      'SELECT COUNT(*) as total FROM'
    );
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);
    
    query += ` ORDER BY b.start_time DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);
    
    const result = await pool.query(query, params);
    
    res.status(200).json({
      success: true,
      data: result.rows,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: parseInt(limit)
      },
      filters: {
        date: date || null,
        room: room || null,
        status: status || null
      }
    });
    
  } catch (err) {
    console.error("Error fetching admin bookings:", err);
    res.status(500).json({ 
      error: "Failed to fetch bookings",
      details: err.message 
    });
  }
});

export default router;