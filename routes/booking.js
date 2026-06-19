// Vyas-Backend\routes\booking.js
import express from "express";
import pool from "../database/db.js";
import { protect, adminOnly } from "../middlewares/authMiddleware.js";
import { enqueueEmail } from "../services/emailQueue.js";

const router = express.Router();

const conflictMetrics = {
  totalAttempts: 0,
  conflictCount: 0,
  lastConflict: null,
};

function recordConflict(roomId, teacherId) {
  conflictMetrics.conflictCount++;
  conflictMetrics.lastConflict = {
    roomId,
    teacherId,
    timestamp: new Date().toISOString(),
  };
  console.log(
    `⚠️  [CONTENTION] Room booking conflict (error 23P01) - Room: ${roomId}, Attempts: ${conflictMetrics.totalAttempts}, Total conflicts: ${conflictMetrics.conflictCount}, Last: ${conflictMetrics.lastConflict.timestamp}`
  );
}

// ==============================
// CREATE BOOKING
// ==============================
router.post("/", protect, async (req, res) => {
  const {
    roomId,
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

  //Track booking attempts
  conflictMetrics.totalAttempts++;

  if (!roomId || !title || !startTime || !endTime) {
    return res.status(400).json({
      error: "Missing required booking fields",
    });
  }

  const start = new Date(startTime);
  const end = new Date(endTime);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return res.status(400).json({ error: "Invalid startTime or endTime" });
  }

  if (end <= start) {
    return res.status(400).json({ error: "End time must be after start time" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const roomCheck = await client.query(
      `SELECT id, requires_approval FROM rooms WHERE id = $1 AND is_active = true`,
      [roomId],
    );

    if (roomCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Room not found" });
    }

    const bookingStatus = roomCheck.rows[0].requires_approval ? "pending" : "confirmed";

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
        is_recurring,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
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
        bookingStatus,
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

    req.app.get("io")?.to(`room:${roomId}`).emit("room:booked", {
      roomId,
      booking: bookingResult.rows[0],
    });

    res.status(201).json({
      success: true,
      booking: bookingResult.rows[0],
    });

    enqueueEmail("booking-confirmation", {
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
      console.error("Failed to enqueue booking confirmation email:", err);
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Booking error:", err);

    // Monitor PostgreSQL concurrency conflicts (error 23P01)
    if (err.code === "23P01") {
      recordConflict(roomId, teacherId);
      return res.status(409).json({
        error: "Room already booked for this time slot",
      });
    }
    res.status(500).json({
      error: "Booking failed",
      details: err.message,
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
// GET /booking/room/:roomId — bookings for a specific room in a date range
// ==============================
router.get("/room/:roomId", protect, async (req, res) => {
  const { roomId } = req.params;
  const { weekStart, weekEnd } = req.query;

  if (!weekStart || !weekEnd) {
    return res.status(400).json({ error: "weekStart and weekEnd are required" });
  }

  try {
    const result = await pool.query(
      `SELECT b.*, r.name AS room_name, p.full_name AS teacher_full_name, p.email AS teacher_email
       FROM bookings b
       JOIN rooms r ON b.room_id = r.id
       LEFT JOIN profiles p ON b.teacher_id = p.id
       WHERE b.room_id = $1
         AND b.status = 'confirmed'
         AND b.start_time >= $2
         AND b.start_time <= $3
       ORDER BY b.start_time`,
      [roomId, weekStart, weekEnd]
    );

    const bookings = result.rows.map((b) => ({
      ...b,
      profiles: { full_name: b.teacher_full_name, email: b.teacher_email },
    }));

    res.json({ success: true, bookings });
  } catch (err) {
    console.error("Error fetching room bookings:", err);
    res.status(500).json({ error: "Failed to fetch bookings" });
  }
});

// ==============================
// PATCH /booking/:id — update booking (owner or admin)
// Also handles admin approve/deny via the `status` field.
// ==============================
router.patch("/:id", protect, async (req, res) => {
  const bookingId = req.params.id;
  const userId = req.user.id;
  const isAdmin = req.user.is_admin;

  const {
    title,
    description,
    start_time,
    end_time,
    class_division,
    panel,
    year_course,
    status,
  } = req.body;

  // Only admins can change status
  if (status !== undefined && !isAdmin) {
    return res.status(403).json({ error: "Only admins can change booking status" });
  }

  const fields = [];
  const values = [];
  let i = 1;

  if (title !== undefined) { fields.push(`title = $${i++}`); values.push(title); }
  if (description !== undefined) { fields.push(`description = $${i++}`); values.push(description || null); }
  if (start_time !== undefined) { fields.push(`start_time = $${i++}`); values.push(start_time); }
  if (end_time !== undefined) { fields.push(`end_time = $${i++}`); values.push(end_time); }
  if (class_division !== undefined) { fields.push(`class_division = $${i++}`); values.push(class_division || null); }
  if (panel !== undefined) { fields.push(`panel = $${i++}`); values.push(panel || null); }
  if (year_course !== undefined) { fields.push(`year_course = $${i++}`); values.push(year_course || null); }
  if (status !== undefined) {
    fields.push(`status = $${i++}`); values.push(status);
    if (status === "confirmed" && isAdmin) {
      fields.push(`approved_by = $${i++}`); values.push(userId);
      fields.push(`approved_at = $${i++}`); values.push(new Date().toISOString());
    }
  }
  fields.push(`updated_at = $${i++}`); values.push(new Date().toISOString());

  if (fields.length <= 1) {
    return res.status(400).json({ error: "No fields to update" });
  }

  values.push(bookingId);
  let query = `UPDATE bookings SET ${fields.join(", ")} WHERE id = $${i}`;

  if (!isAdmin) {
    query += ` AND teacher_id = $${i + 1}`;
    values.push(userId);
  }
  query += " RETURNING *";

  try {
    const result = await pool.query(query, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Booking not found or access denied" });
    }
    res.json({ success: true, booking: result.rows[0] });
  } catch (err) {
    console.error("Error updating booking:", err);
    res.status(500).json({ error: "Failed to update booking", details: err.message });
  }
});

// ==============================
// MONITORING: View concurrency metrics (Phase 7)
// ==============================
router.get("/metrics/contention", protect, adminOnly, (req, res) => {
  const conflictRate = conflictMetrics.totalAttempts > 0
    ? ((conflictMetrics.conflictCount / conflictMetrics.totalAttempts) * 100).toFixed(2)
    : 0;

  res.json({
    success: true,
    metrics: {
      totalBookingAttempts: conflictMetrics.totalAttempts,
      conflictCount: conflictMetrics.conflictCount,
      conflictRate: `${conflictRate}%`,
      lastConflict: conflictMetrics.lastConflict,
      note: "Conflicts indicate successful PostgreSQL exclusion constraint enforcement",
    },
  });
});

export default router;