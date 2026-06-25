// services/bookingGenerator.js
//
// Writes the human-approved extracted lectures into room_timetable_templates
// — the same table routes/timetable.js's `POST /room/:id/timetable` inserts
// into. We write directly to the table (same process, same DB pool) rather
// than making an HTTP call to ourselves.
//
// IMPORTANT: room_timetable_templates.weekday is 0=Monday..6=Sunday, while
// timetable_extracted_lectures.weekday_number is 1=Monday..7=Sunday (see
// normalizationService.js) — every write here converts with `- 1`.

import pool from '../database/db.js';

export async function generateBookingsForJob(jobId) {
  const lecturesRes = await pool.query(
    `SELECT l.*, j.effective_from, j.created_by AS job_created_by
     FROM timetable_extracted_lectures l
     JOIN timetable_import_jobs j ON j.id = l.job_id
     WHERE l.job_id = $1 AND l.status = 'APPROVED'`,
    [jobId]
  );

  const lectures = lecturesRes.rows;
  let successCount = 0;
  let failCount = 0;

  for (const lecture of lectures) {
    const roomRes = await pool.query(
      `SELECT id FROM rooms WHERE LOWER(name) = LOWER($1) AND is_active = TRUE LIMIT 1`,
      [lecture.room_number]
    );

    if (!roomRes.rows.length) {
      await saveBookingLog(
        lecture.id,
        { room_number: lecture.room_number },
        null,
        null,
        'FAILED',
        1,
        `Room "${lecture.room_number}" not found in database`
      );
      await pool.query(`UPDATE timetable_extracted_lectures SET status = 'BOOKING_FAILED' WHERE id = $1`, [
        lecture.id,
      ]);
      failCount++;
      continue;
    }

    const roomId = roomRes.rows[0].id;
    const payload = buildTemplatePayload(lecture, roomId);

    let attempt = 0;
    let success = false;
    let lastError = null;

    while (attempt < 3 && !success) {
      attempt++;
      try {
        await pool.query(
          `INSERT INTO room_timetable_templates
             (room_id, teacher_name, title, weekday, start_time,
              duration_minutes, notes, repeat_interval_weeks, effective_from, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            roomId,
            payload.teacher_name,
            payload.title,
            payload.weekday,
            payload.start_time,
            payload.duration_minutes,
            payload.notes,
            payload.repeat_interval_weeks,
            payload.effective_from,
            lecture.job_created_by,
          ]
        );

        await saveBookingLog(lecture.id, payload, null, 201, 'SUCCESS', attempt, null);
        await pool.query(`UPDATE timetable_extracted_lectures SET status = 'BOOKING_CREATED' WHERE id = $1`, [
          lecture.id,
        ]);
        successCount++;
        success = true;
      } catch (err) {
        lastError = err.message;
        console.error(`[BookingGen] Attempt ${attempt} failed for lecture ${lecture.id}:`, err.message);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }

    if (!success) {
      await saveBookingLog(lecture.id, payload, null, null, 'FAILED', attempt, lastError);
      await pool.query(`UPDATE timetable_extracted_lectures SET status = 'BOOKING_FAILED' WHERE id = $1`, [
        lecture.id,
      ]);
      failCount++;
    }
  }

  await pool.query(
    `UPDATE timetable_import_jobs
     SET status = 'COMPLETED', updated_at = NOW(), error_message = $1
     WHERE id = $2`,
    [`${successCount} bookings created, ${failCount} failed`, jobId]
  );

  return { successCount, failCount };
}

function buildTemplatePayload(lecture, roomId) {
  const noteParts = [];
  if (lecture.batch) noteParts.push(`Batch: ${lecture.batch}`);
  if (lecture.lecture_type) noteParts.push(`Type: ${lecture.lecture_type}`);

  return {
    room_id: roomId,
    teacher_name: lecture.teacher_name,
    title: lecture.subject,
    // weekday_number is 1=Mon..7=Sun; room_timetable_templates.weekday is 0=Mon..6=Sun
    weekday: lecture.weekday_number - 1,
    start_time: lecture.start_time,
    duration_minutes: lecture.duration_minutes,
    notes: noteParts.length ? `[Imported] ${noteParts.join(', ')}` : null,
    repeat_interval_weeks: 1,
    effective_from: lecture.effective_from || new Date().toISOString().split('T')[0],
  };
}

async function saveBookingLog(lectureId, requestPayload, responsePayload, httpStatus, status, attemptCount, errorMessage) {
  await pool.query(
    `INSERT INTO timetable_booking_logs
       (lecture_id, request_payload, response_payload, http_status, status, attempt_count, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      lectureId,
      JSON.stringify(requestPayload),
      responsePayload !== null ? JSON.stringify(responsePayload) : null,
      httpStatus,
      status,
      attemptCount,
      errorMessage,
    ]
  );
}
