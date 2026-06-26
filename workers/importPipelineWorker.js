// workers/importPipelineWorker.js
//
// Can be started inline (via startImportPipelineWorker()) or as a standalone
// process: node workers/importPipelineWorker.js
//
import 'dotenv/config';
import { fileURLToPath } from 'url';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import pool from '../database/db.js';
import { extractTextFromFile } from '../services/extractionService.js';
import { ocrPdf } from '../services/ocrService.js';
import { normalizeExtractedText, normalizeLlmLecture } from '../services/normalizationService.js';
import { extractLecturesFromText, GEMINI_MODEL_NAME } from '../services/llmService.js';
import { correlateLectures } from '../services/correlationEngine.js';
import { detectConflicts } from '../services/conflictDetector.js';
import { generateBookingsForJob } from '../services/bookingGenerator.js';

async function processImportJob({ jobId }) {
  console.log(`[ImportWorker] Starting pipeline for job ${jobId}`);

  try {
    // ── 1. Fetch files ──────────────────────────────────────────────────────
    const filesRes = await pool.query(`SELECT * FROM timetable_import_files WHERE job_id = $1`, [jobId]);
    const files = filesRes.rows;

    // ── 2. Extract text from each file ─────────────────────────────────────
    const lecturesByFile = [];

    for (const file of files) {
      await pool.query(`UPDATE timetable_import_files SET extraction_status = 'PROCESSING' WHERE id = $1`, [
        file.id,
      ]);

      let text;
      let ocrUsed = false;
      try {
        const extracted = await extractTextFromFile(file.storage_path, file.mime_type);
        if (extracted.needsOcr) {
          console.log(`[ImportWorker] Running OCR on ${file.original_filename}`);
          text = await ocrPdf(file.storage_path);
          ocrUsed = true;
        } else {
          text = extracted.text;
        }
      } catch (err) {
        console.error(`[ImportWorker] Text extraction failed for ${file.original_filename}:`, err.message);
        await pool.query(`UPDATE timetable_import_files SET extraction_status = 'FAILED' WHERE id = $1`, [
          file.id,
        ]);
        continue; // Skip this file, process others
      }

      const normalizedText = normalizeExtractedText(text);

      await pool.query(
        `UPDATE timetable_import_files
         SET raw_text = $1, ocr_used = $2, extraction_status = 'COMPLETED'
         WHERE id = $3`,
        [normalizedText, ocrUsed, file.id]
      );

      // ── 3. LLM extraction ───────────────────────────────────────────────
      let rawLectures = [];
      try {
        rawLectures = await extractLecturesFromText(normalizedText);
        console.log(`[ImportWorker] LLM extracted ${rawLectures.length} lectures from ${file.original_filename}`);
      } catch (err) {
        console.error(`[ImportWorker] LLM failed for ${file.original_filename}:`, err.message);
        // Continue — partial extraction is better than total failure
      }

      // ── 4. Normalize + save each lecture ────────────────────────────────
      const savedLectures = [];
      for (const rawLecture of rawLectures) {
        const normalized = normalizeLlmLecture(rawLecture);
        const res = await pool.query(
          `INSERT INTO timetable_extracted_lectures
             (job_id, source_file_id,
              raw_teacher_name, raw_subject, raw_room_number, raw_weekday,
              raw_start_time, raw_duration_minutes, raw_batch, raw_lecture_type,
              teacher_name, subject, room_number, weekday_number, start_time,
              duration_minutes, batch, lecture_type,
              confidence, confidence_score, missing_fields,
              llm_model_used, llm_raw_response)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
           RETURNING *`,
          [
            jobId, file.id,
            rawLecture.teacherName, rawLecture.subject, rawLecture.roomNumber,
            rawLecture.weekday, rawLecture.startTime, rawLecture.durationMinutes,
            rawLecture.batch, rawLecture.lectureType,
            normalized.teacher_name, normalized.subject, normalized.room_number,
            normalized.weekday_number, normalized.start_time, normalized.duration_minutes,
            normalized.batch, normalized.lecture_type,
            normalized.confidence, normalized.confidence_score, normalized.missing_fields,
            GEMINI_MODEL_NAME, JSON.stringify(rawLecture),
          ]
        );
        savedLectures.push(res.rows[0]);
      }
      lecturesByFile.push(savedLectures);
    }

    // ── 5. Correlation (if multiple files) ──────────────────────────────────
    const allLectures = lecturesByFile.flat();
    if (lecturesByFile.length > 1) {
      const { warnings } = correlateLectures(lecturesByFile);
      for (const w of warnings) {
        await pool.query(
          `INSERT INTO timetable_import_conflicts (job_id, conflict_type, severity, description)
           VALUES ($1, 'DUPLICATE', 'WARNING', $2)`,
          [jobId, w]
        );
      }
    }

    // ── 6. Conflict detection ───────────────────────────────────────────────
    const conflicts = detectConflicts(allLectures);
    for (const c of conflicts) {
      await pool.query(
        `INSERT INTO timetable_import_conflicts
           (job_id, conflict_type, severity, lecture_ids, description)
         VALUES ($1, $2, $3, $4, $5)`,
        [jobId, c.conflict_type, c.severity, c.lecture_ids, c.description]
      );
    }

    // ── 7. Update job status → REVIEW_REQUIRED ─────────────────────────────
    await pool.query(
      `UPDATE timetable_import_jobs SET status = 'REVIEW_REQUIRED', updated_at = NOW() WHERE id = $1`,
      [jobId]
    );

    console.log(`[ImportWorker] Job ${jobId} complete — ${allLectures.length} lectures, ${conflicts.length} conflicts`);
  } catch (err) {
    console.error(`[ImportWorker] Job ${jobId} FAILED:`, err.message);
    await pool.query(
      `UPDATE timetable_import_jobs SET status = 'FAILED', error_message = $1, updated_at = NOW() WHERE id = $2`,
      [err.message, jobId]
    );
  }
}

async function processBookingGeneration({ jobId }) {
  console.log(`[ImportWorker] Starting booking generation for job ${jobId}`);
  try {
    const { successCount, failCount } = await generateBookingsForJob(jobId);
    console.log(`[ImportWorker] Job ${jobId} booking generation done — ${successCount} created, ${failCount} failed`);
  } catch (err) {
    console.error(`[ImportWorker] Booking generation for job ${jobId} FAILED:`, err.message);
    await pool.query(
      `UPDATE timetable_import_jobs SET status = 'FAILED', error_message = $1, updated_at = NOW() WHERE id = $2`,
      [err.message, jobId]
    );
  }
}

async function processJob(job) {
  switch (job.name) {
    case 'process-import':
      return processImportJob(job.data);
    case 'generate-bookings':
      return processBookingGeneration(job.data);
    default:
      throw new Error(`Unknown import job type: "${job.name}"`);
  }
}

export function startImportPipelineWorker() {
  const connection = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
  });

  const worker = new Worker('timetable-import', processJob, { connection, concurrency: 1 });

  worker.on('completed', (job) => console.log(`[ImportWorker] Job ${job.id} (${job.name}) completed`));
  worker.on('failed', (job, err) => console.error(`[ImportWorker] Job ${job?.id} (${job?.name}) failed:`, err.message));
  worker.on('error', (err) => console.error('[ImportWorker] Worker error:', err));

  console.log('📥 Timetable import worker started');
  return worker;
}

// Standalone entry point — runs only when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startImportPipelineWorker();
}
