// routes/timetable.js
import express from "express";
import pool from "../database/db.js";
import { protect, adminOnly } from "../middlewares/authMiddleware.js";

const router = express.Router();

// ==============================
// GET /room/:id/effective-timetable?weekStart=YYYY-MM-DD
// Returns effective timetable slots (templates merged with bookings & exceptions)
// Falls back to manual computation if the SQL function doesn't exist.
// ==============================
router.get("/room/:id/effective-timetable", protect, async (req, res) => {
  const roomId = req.params.id;
  const weekStart = req.query.weekStart;

  if (!weekStart) {
    return res.status(400).json({ error: "weekStart is required (YYYY-MM-DD)" });
  }

  try {
    // Try calling the PostgreSQL function first
    const fnResult = await pool.query(
      `SELECT * FROM get_effective_timetable($1::uuid, $2::date)`,
      [roomId, weekStart]
    );
    return res.json({ success: true, slots: fnResult.rows });
  } catch (fnErr) {
    // If the function doesn't exist, compute manually
    if (!fnErr.code || fnErr.code !== "42883") {
      console.error("Effective timetable error:", fnErr);
      return res.status(500).json({ error: "Failed to fetch effective timetable" });
    }

    // Manual fallback: compute from templates + bookings + exceptions
    try {
      const weekStartDate = new Date(weekStart + "T00:00:00");
      const weekEndDate = new Date(weekStartDate);
      weekEndDate.setDate(weekEndDate.getDate() + 7);

      // Get active templates
      const templatesRes = await pool.query(
        `SELECT * FROM room_timetable_templates WHERE room_id = $1 AND is_active = true`,
        [roomId]
      );

      // Get exceptions for this week
      const exceptionsRes = await pool.query(
        `SELECT * FROM room_timetable_template_exceptions WHERE week_start_date = $1`,
        [weekStart]
      );
      const cancelledTemplateIds = new Set(
        exceptionsRes.rows.map((e) => e.template_id)
      );

      // Get confirmed bookings for this week
      const bookingsRes = await pool.query(
        `SELECT b.*, p.full_name AS teacher_name
         FROM bookings b
         LEFT JOIN profiles p ON b.teacher_id = p.id
         WHERE b.room_id = $1
           AND b.status = 'confirmed'
           AND b.start_time >= $2
           AND b.start_time < $3`,
        [roomId, weekStartDate.toISOString(), weekEndDate.toISOString()]
      );

      const slots = [];

      // Add bookings as slots
      for (const booking of bookingsRes.rows) {
        slots.push({
          slot_id: `booking-${booking.id}`,
          slot_type: "booking",
          title: booking.title,
          start_time: booking.start_time,
          end_time: booking.end_time,
          teacher_name: booking.teacher_name,
          booking_id: booking.id,
          template_id: null,
          is_cancelled: false,
        });
      }

      // Add template slots
      for (const tmpl of templatesRes.rows) {
        const isCancelled = cancelledTemplateIds.has(tmpl.id);
        // Find the day in the week matching the weekday (0=Mon, 6=Sun)
        for (let d = 0; d < 7; d++) {
          const day = new Date(weekStartDate);
          day.setDate(day.getDate() + d);
          const dayOfWeek = day.getDay() === 0 ? 6 : day.getDay() - 1; // 0=Mon

          if (dayOfWeek !== tmpl.weekday) continue;

          // Check repeat interval
          const effectiveFrom = new Date(tmpl.effective_from);
          const weekDiff = Math.floor(
            (weekStartDate.getTime() - effectiveFrom.getTime()) /
              (7 * 24 * 60 * 60 * 1000)
          );
          if (weekDiff < 0) continue;
          if (tmpl.repeat_interval_weeks > 1 && weekDiff % tmpl.repeat_interval_weeks !== 0) continue;

          // Build start/end times
          const [startHr, startMin] = tmpl.start_time.split(":").map(Number);
          const slotStart = new Date(day);
          slotStart.setHours(startHr, startMin, 0, 0);
          const slotEnd = new Date(slotStart);
          slotEnd.setMinutes(slotEnd.getMinutes() + tmpl.duration_minutes);

          slots.push({
            slot_id: isCancelled
              ? `exception-${tmpl.id}-${weekStart}`
              : `template-${tmpl.id}-${d}`,
            slot_type: isCancelled ? "exception_cancelled" : "template",
            title: tmpl.title,
            start_time: slotStart.toISOString(),
            end_time: slotEnd.toISOString(),
            teacher_name: tmpl.teacher_name,
            booking_id: null,
            template_id: tmpl.id,
            is_cancelled: isCancelled,
          });
        }
      }

      return res.json({ success: true, slots });
    } catch (fallbackErr) {
      console.error("Fallback timetable error:", fallbackErr);
      return res.status(500).json({ error: "Failed to compute effective timetable" });
    }
  }
});

// ==============================
// GET /room/:id/timetable
// List all timetable templates for a room
// ==============================
router.get("/room/:id/timetable", protect, async (req, res) => {
  try {
    const roomId = req.params.id;

    const result = await pool.query(
      `SELECT t.*, p.full_name AS created_by_name
       FROM room_timetable_templates t
       LEFT JOIN profiles p ON p.id = t.created_by
       WHERE t.room_id = $1
       ORDER BY t.weekday, t.start_time`,
      [roomId],
    );

    res.json({ success: true, templates: result.rows });
  } catch (err) {
    console.error("Error fetching timetable templates:", err);
    res.status(500).json({ error: "Failed to fetch timetable templates" });
  }
});

// ==============================
// POST /room/:id/timetable
// Create a timetable template for a room (admin only)
// ==============================
router.post("/room/:id/timetable", protect, adminOnly, async (req, res) => {
  const roomId = req.params.id;
  const {
    teacherName,
    title,
    weekday,
    startTime,
    durationMinutes,
    notes,
    repeatIntervalWeeks = 2,
    effectiveFrom,
  } = req.body;

  if (
    !teacherName ||
    !title ||
    weekday === undefined ||
    !startTime ||
    !durationMinutes
  ) {
    return res.status(400).json({
      error:
        "Missing required fields: teacherName, title, weekday, startTime, durationMinutes",
    });
  }

  if (weekday < 0 || weekday > 6) {
    return res
      .status(400)
      .json({ error: "weekday must be 0 (Monday) to 6 (Sunday)" });
  }

  if (durationMinutes <= 0) {
    return res.status(400).json({ error: "durationMinutes must be positive" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO room_timetable_templates
         (room_id, teacher_name, title, weekday, start_time, duration_minutes,
          notes, repeat_interval_weeks, effective_from, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        roomId,
        teacherName,
        title,
        weekday,
        startTime,
        durationMinutes,
        notes || null,
        repeatIntervalWeeks,
        effectiveFrom || new Date().toISOString().split("T")[0],
        req.user.id,
      ],
    );

    res.status(201).json({ success: true, template: result.rows[0] });
  } catch (err) {
    console.error("Error creating timetable template:", err);
    if (err.code === "23503") {
      return res.status(404).json({ error: "Room not found" });
    }
    res.status(500).json({ error: "Failed to create timetable template" });
  }
});

// ==============================
// PUT /timetable/:id
// Update a timetable template (admin only)
// Accepts any subset of fields — only the provided ones are updated.
// ==============================
router.put("/timetable/:id", protect, adminOnly, async (req, res) => {
  const templateId = req.params.id;
  const {
    teacherName,
    title,
    weekday,
    startTime,
    durationMinutes,
    notes,
    repeatIntervalWeeks,
    effectiveFrom,
    isActive,
  } = req.body;

  const fields = [];
  const values = [];
  let i = 1;

  if (teacherName !== undefined) {
    fields.push(`teacher_name = $${i++}`);
    values.push(teacherName);
  }
  if (title !== undefined) {
    fields.push(`title = $${i++}`);
    values.push(title);
  }
  if (weekday !== undefined) {
    if (weekday < 0 || weekday > 6) {
      return res
        .status(400)
        .json({ error: "weekday must be 0 (Monday) to 6 (Sunday)" });
    }
    fields.push(`weekday = $${i++}`);
    values.push(weekday);
  }
  if (startTime !== undefined) {
    fields.push(`start_time = $${i++}`);
    values.push(startTime);
  }
  if (durationMinutes !== undefined) {
    if (durationMinutes <= 0)
      return res
        .status(400)
        .json({ error: "durationMinutes must be positive" });
    fields.push(`duration_minutes = $${i++}`);
    values.push(durationMinutes);
  }
  if (notes !== undefined) {
    fields.push(`notes = $${i++}`);
    values.push(notes);
  }
  if (repeatIntervalWeeks !== undefined) {
    fields.push(`repeat_interval_weeks = $${i++}`);
    values.push(repeatIntervalWeeks);
  }
  if (effectiveFrom !== undefined) {
    fields.push(`effective_from = $${i++}`);
    values.push(effectiveFrom);
  }
  if (isActive !== undefined) {
    fields.push(`is_active = $${i++}`);
    values.push(isActive);
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  try {
    values.push(templateId);
    const result = await pool.query(
      `UPDATE room_timetable_templates SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values,
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Timetable template not found" });
    }

    res.json({ success: true, template: result.rows[0] });
  } catch (err) {
    console.error("Error updating timetable template:", err);
    res.status(500).json({ error: "Failed to update timetable template" });
  }
});

// ==============================
// DELETE /timetable/:id
// Delete a timetable template (admin only)
// ==============================
router.delete("/timetable/:id", protect, adminOnly, async (req, res) => {
  try {
    const templateId = req.params.id;

    const result = await pool.query(
      `DELETE FROM room_timetable_templates WHERE id = $1 RETURNING id, title`,
      [templateId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Timetable template not found" });
    }

    res.json({
      success: true,
      message: `Template "${result.rows[0].title}" deleted`,
    });
  } catch (err) {
    console.error("Error deleting timetable template:", err);
    res.status(500).json({ error: "Failed to delete timetable template" });
  }
});

// ==============================
// POST /timetable/:id/exception
// Cancel a template slot for a specific week.
// Delegates to the PostgreSQL function create_template_exception() which
// enforces: admin OR the teacher named on the template.
// ==============================
router.post("/timetable/:id/exception", protect, async (req, res) => {
  const templateId = req.params.id;
  const { weekStartDate, reason } = req.body;

  if (!weekStartDate) {
    return res
      .status(400)
      .json({ error: "weekStartDate is required (YYYY-MM-DD)" });
  }

  try {
    const fnResult = await pool.query(
      `SELECT create_template_exception($1, $2::date, $3, $4) AS exception_id`,
      [templateId, weekStartDate, req.user.id, reason || null],
    );

    const exceptionId = fnResult.rows[0].exception_id;

    const exceptionResult = await pool.query(
      `SELECT * FROM room_timetable_template_exceptions WHERE id = $1`,
      [exceptionId],
    );

    res.status(201).json({ success: true, exception: exceptionResult.rows[0] });
  } catch (err) {
    console.error("Error creating template exception:", err);
    if (err.message?.includes("Permission denied")) {
      return res.status(403).json({ error: err.message });
    }
    if (err.message?.includes("Template not found")) {
      return res.status(404).json({ error: "Timetable template not found" });
    }
    res.status(500).json({ error: "Failed to create template exception" });
  }
});

export default router;
