// services/lectureStorage.js
//
// Normalize + insert one LLM-extracted lecture into timetable_extracted_lectures.
// Extracted out of importPipelineWorker.js's main loop so
// POST /jobs/:jobId/files/:fileId/retry-failed-chunks can reuse the exact
// same insert shape instead of duplicating it.

import pool from '../database/db.js';
import { normalizeLlmLecture } from './normalizationService.js';
import { GEMINI_MODEL_NAME } from './llmService.js';

export async function saveExtractedLecture(jobId, fileId, rawLecture) {
  const normalized = normalizeLlmLecture(rawLecture);
  const res = await pool.query(
    `INSERT INTO timetable_extracted_lectures
       (job_id, source_file_id,
        raw_teacher_name, raw_subject, raw_room_number, raw_weekday,
        raw_start_time, raw_duration_minutes, raw_batch, raw_lecture_type,
        teacher_name, subject, room_number, weekday_number, start_time,
        duration_minutes, batch, lecture_type,
        confidence, confidence_score, missing_fields,
        llm_model_used, llm_raw_response, panel_label, sheet_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
     RETURNING *`,
    [
      jobId, fileId,
      rawLecture.teacherName, rawLecture.subject, rawLecture.roomNumber,
      rawLecture.weekday, rawLecture.startTime, rawLecture.durationMinutes,
      rawLecture.batch, rawLecture.lectureType,
      normalized.teacher_name, normalized.subject, normalized.room_number,
      normalized.weekday_number, normalized.start_time, normalized.duration_minutes,
      normalized.batch, normalized.lecture_type,
      normalized.confidence, normalized.confidence_score, normalized.missing_fields,
      GEMINI_MODEL_NAME, JSON.stringify(rawLecture),
      // Panel/sheet identity threaded from the chunk this lecture came from
      // (see llmService.js's extractLecturesFromText) — used later by
      // legendBackfill.js to find the right panel's legend lookup. Absent
      // (null) for PDF/CSV sources or the pre-panel "(none)" bucket.
      rawLecture._panelLabel ?? null, rawLecture._sheetName ?? null,
    ]
  );
  return res.rows[0];
}
