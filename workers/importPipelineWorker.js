// workers/importPipelineWorker.js
//
// Can be started inline (via startImportPipelineWorker()) or as a standalone
// process: node workers/importPipelineWorker.js
//
import 'dotenv/config';
import { fileURLToPath } from 'url';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import pool from '../database/db.js';
import { IMPORT_CONFIG } from '../config/importConfig.js';
import { extractTextFromFile } from '../services/extractionService.js';
import { ocrPdf } from '../services/ocrService.js';
import { normalizeExtractedText } from '../services/normalizationService.js';
import { extractLecturesFromText, computeJobDeadlineMs, retryChunk } from '../services/llmService.js';
import { correlateLectures } from '../services/correlationEngine.js';
import { detectConflicts } from '../services/conflictDetector.js';
import { generateBookingsForJob } from '../services/bookingGenerator.js';
import { saveExtractedLecture } from '../services/lectureStorage.js';
import {
  setStage, logEvent, isCancelled, handleCancellation, markFailed, markProcessingStarted,
} from '../services/importProgress.js';
import { startReconciliationSweep } from '../services/importReconciliation.js';
import { backfillLecturesFromLegend } from '../services/legendBackfill.js';
import { serializePanels, deserializePanels } from '../services/timetableStructureParser.js';

const s3Client = new S3Client({});

async function fetchFileBuffer(key) {
  const { Body } = await s3Client.send(new GetObjectCommand({ Bucket: IMPORT_CONFIG.s3Bucket, Key: key }));
  return Buffer.from(await Body.transformToByteArray());
}

async function processImportJob({ jobId }) {
  console.log(`[ImportWorker] Starting pipeline for job ${jobId}`);

  try {
    // ── 1. Fetch files ──────────────────────────────────────────────────────
    const filesRes = await pool.query(`SELECT * FROM timetable_import_files WHERE job_id = $1`, [jobId]);
    const files = filesRes.rows;

    await setStage(jobId, 'QUEUED', { filesTotal: files.length, filesCompleted: 0 });
    await markProcessingStarted(jobId);
    // Conservative backstop, not yet calibrated from real latency data — see
    // ESTIMATED_CHUNKS_PER_FILE in llmService.js.
    const deadlineAt = Date.now() + computeJobDeadlineMs(files.length);

    // ── 2. Extract text from each file ─────────────────────────────────────
    const lecturesByFile = [];
    const legendsByFile = [];
    let filesCompleted = 0;

    for (const file of files) {
      if (await isCancelled(jobId)) { await handleCancellation(jobId); return; }

      await setStage(jobId, 'READING_FILE', { fileId: file.id });
      await pool.query(`UPDATE timetable_import_files SET extraction_status = 'PROCESSING' WHERE id = $1`, [
        file.id,
      ]);

      let text;
      let ocrUsed = false;
      let panels = [];
      try {
        const fileBuffer = await fetchFileBuffer(file.storage_path);
        const extracted = await extractTextFromFile(fileBuffer, file.mime_type);
        panels = extracted.panels || [];
        if (extracted.needsOcr) {
          if (await isCancelled(jobId)) { await handleCancellation(jobId); return; }
          await setStage(jobId, 'OCR', { fileId: file.id });
          console.log(`[ImportWorker] Running OCR on ${file.original_filename}`);
          text = await ocrPdf(fileBuffer);
          ocrUsed = true;
          panels = []; // OCR text has no structured panel/legend concept
        } else {
          text = extracted.text;
        }
      } catch (err) {
        console.error(`[ImportWorker] Text extraction failed for ${file.original_filename}:`, err.message);
        await pool.query(`UPDATE timetable_import_files SET extraction_status = 'FAILED' WHERE id = $1`, [
          file.id,
        ]);
        await logEvent(jobId, 'ERROR', `Text extraction failed for ${file.original_filename}: ${err.message}`, null, file.id);
        continue; // Skip this file, process others
      }

      const normalizedText = normalizeExtractedText(text);
      legendsByFile.push({ fileId: file.id, panels });

      await pool.query(
        `UPDATE timetable_import_files
         SET raw_text = $1, ocr_used = $2, extraction_status = 'COMPLETED', panel_legend = $3
         WHERE id = $4`,
        [normalizedText, ocrUsed, JSON.stringify(serializePanels(panels)), file.id]
      );

      // ── 3. LLM extraction ───────────────────────────────────────────────
      if (await isCancelled(jobId)) { await handleCancellation(jobId); return; }
      await setStage(jobId, 'CALLING_LLM', { fileId: file.id });
      let rawLectures = [];
      let failedChunks = [];
      try {
        const extraction = await extractLecturesFromText(normalizedText, jobId, { deadlineAt });
        rawLectures = extraction.lectures;
        failedChunks = extraction.failedChunks;
        if (rawLectures.length === 0 && failedChunks.length > 0) {
          // Every chunk in this file exhausted its retries — extractLecturesFromText
          // deliberately does not throw for this case anymore (see its own
          // comment) so failedChunks still reaches the persistence step below
          // and the retry endpoint has something to work with. Still log an
          // ERROR event here so this is visible the same way a total failure
          // always was, before chunk-level tracking existed.
          console.error(`[ImportWorker] LLM extraction produced 0 lectures for ${file.original_filename} — all ${failedChunks.length} chunk(s) failed`);
          await logEvent(jobId, 'ERROR', `LLM extraction failed for ${file.original_filename}: ${failedChunks[0].errorMessage}`, null, file.id);
        } else {
          console.log(`[ImportWorker] LLM extracted ${rawLectures.length} lectures from ${file.original_filename}`);
        }
      } catch (err) {
        if (err.name === 'UserCancelledError') {
          await handleCancellation(jobId);
          return;
        }
        if (err.name === 'DeadlineExceededError') {
          await logEvent(jobId, 'ERROR', err.message, null, file.id);
          const failureCode = await markFailed(jobId, err);
          console.error(`[ImportWorker] job=${jobId} failed code=${failureCode}:`, err.message);
          return;
        }
        console.error(`[ImportWorker] LLM failed for ${file.original_filename}:`, err.message);
        await logEvent(jobId, 'ERROR', `LLM extraction failed for ${file.original_filename}: ${err.message}`, null, file.id);
        // Continue — partial extraction is better than total failure
      }

      if (await isCancelled(jobId)) { await handleCancellation(jobId); return; }

      // ── 4. Normalize + save each lecture ────────────────────────────────
      const savedLectures = [];
      for (const rawLecture of rawLectures) {
        savedLectures.push(await saveExtractedLecture(jobId, file.id, rawLecture));
      }
      lecturesByFile.push(savedLectures);

      // Persist which chunks (if any) exhausted their retries for this file,
      // so the review UI can show what may be missing and an admin can
      // retry just those sections later — see services/llmService.js's
      // retryChunk() and POST /jobs/:jobId/files/:fileId/retry-failed-chunks.
      if (failedChunks.length > 0) {
        await pool.query(`UPDATE timetable_import_files SET failed_chunks = $1 WHERE id = $2`, [
          JSON.stringify(failedChunks),
          file.id,
        ]);
        await logEvent(
          jobId,
          'CHUNK_EXTRACTION_INCOMPLETE',
          `${failedChunks.length} of ${failedChunks[0].totalChunks} section(s) could not be processed for ${file.original_filename} — some lectures may be missing`,
          null,
          file.id
        );
      }

      filesCompleted++;
      await logEvent(jobId, 'FILE_COMPLETED', `Processed ${file.original_filename}`, null, file.id);
      await setStage(jobId, 'READING_FILE', { filesCompleted });
    }

    if (await isCancelled(jobId)) { await handleCancellation(jobId); return; }

    // ── 4.5. Deterministic panel-legend backfill ─────────────────────────────
    // Plain code, not another LLM call — a lookup/join against each file's
    // own per-panel Theory/Lab legend (parsed at extraction time, see
    // extractionService.js/timetableStructureParser.js), run once after ALL
    // chunks/files have finished so it never races the LLM extraction loop.
    // Runs before correlation/conflict detection so both see the
    // post-backfill missing_fields, not the pre-backfill LLM output.
    await setStage(jobId, 'BACKFILLING_LEGEND', {});
    let totalBackfilled = 0;
    for (let fi = 0; fi < lecturesByFile.length; fi++) {
      const legendEntry = legendsByFile[fi];
      if (!legendEntry || legendEntry.panels.length === 0 || lecturesByFile[fi].length === 0) continue;
      const { backfilledCount, exactCount, fuzzyCount } = await backfillLecturesFromLegend(
        lecturesByFile[fi], legendEntry.panels, pool
      );
      totalBackfilled += backfilledCount;
      if (backfilledCount > 0) {
        await logEvent(
          jobId,
          'LEGEND_BACKFILL',
          `Backfilled ${backfilledCount} lecture(s) from panel legends (exact=${exactCount}, fuzzy=${fuzzyCount})`,
          null,
          legendEntry.fileId
        );
      }
    }
    if (totalBackfilled > 0) {
      console.log(`[ImportWorker] Job ${jobId} legend backfill — ${totalBackfilled} lecture(s) resolved`);
    }

    // ── 5. Correlation (if multiple files) ──────────────────────────────────
    await setStage(jobId, 'CORRELATING', { filesTotal: files.length, filesCompleted: files.length });
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

    if (await isCancelled(jobId)) { await handleCancellation(jobId); return; }

    // ── 6. Conflict detection ───────────────────────────────────────────────
    await setStage(jobId, 'DETECTING_CONFLICTS', {});
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
    await setStage(jobId, 'DONE', {});
    await pool.query(
      `UPDATE timetable_import_jobs SET status = 'REVIEW_REQUIRED', updated_at = NOW() WHERE id = $1`,
      [jobId]
    );

    console.log(`[ImportWorker] Job ${jobId} complete — ${allLectures.length} lectures, ${conflicts.length} conflicts`);
  } catch (err) {
    await logEvent(jobId, 'ERROR', err.message);
    const failureCode = await markFailed(jobId, err);
    console.error(`[ImportWorker] job=${jobId} failed code=${failureCode}:`, err.message);
  }
}

async function processBookingGeneration({ jobId }) {
  console.log(`[ImportWorker] Starting booking generation for job ${jobId}`);
  try {
    const { successCount, failCount } = await generateBookingsForJob(jobId);
    console.log(`[ImportWorker] Job ${jobId} booking generation done — ${successCount} created, ${failCount} failed`);
  } catch (err) {
    await logEvent(jobId, 'ERROR', err.message);
    const failureCode = await markFailed(jobId, err);
    console.error(`[ImportWorker] job=${jobId} failed code=${failureCode}:`, err.message);
  }
}

// Re-runs just the chunks recorded in a file's failed_chunks column (see
// llmService.js's extractLecturesFromText/retryChunk). Deliberately does not
// touch timetable_import_jobs.status or call markFailed() on error — this
// job can run against a file whose parent job is already REVIEW_REQUIRED,
// APPROVED, or COMPLETED, and a chunk retry failing must not clobber that.
async function processRetryFailedChunks({ jobId, fileId }) {
  console.log(`[ImportWorker] Retrying failed chunks for file ${fileId} (job ${jobId})`);
  try {
    const fileRes = await pool.query(
      'SELECT failed_chunks, panel_legend FROM timetable_import_files WHERE id = $1',
      [fileId]
    );
    if (!fileRes.rows.length) {
      console.error(`[ImportWorker] retry-failed-chunks: file ${fileId} not found`);
      return;
    }
    const failedChunks = fileRes.rows[0].failed_chunks || [];
    if (!failedChunks.length) {
      console.log(`[ImportWorker] retry-failed-chunks: file ${fileId} has no failed chunks, nothing to do`);
      return;
    }
    // A separate worker invocation from the original extraction — the
    // in-memory panel lookups from that run are gone, so re-read the
    // durable copy persisted alongside raw_text (see migration 007).
    const panels = deserializePanels(fileRes.rows[0].panel_legend);

    const stillFailed = [];
    const recoveredLecturesForBackfill = [];
    for (const failedChunk of failedChunks) {
      try {
        const lectures = await retryChunk(failedChunk.chunkText, jobId, {
          chunkIndex: failedChunk.chunkIndex,
          totalChunks: failedChunk.totalChunks,
        });
        for (const rawLecture of lectures) {
          // Same panel/sheet identity the original chunk carried (stored on
          // the failed-chunk record itself, see llmService.js) — without
          // this, chunks recovered via manual retry would silently lose
          // panel attribution and never get legend-backfilled.
          rawLecture._panelLabel = failedChunk.panelLabel ?? null;
          rawLecture._sheetName = failedChunk.sheetName ?? null;
          recoveredLecturesForBackfill.push(await saveExtractedLecture(jobId, fileId, rawLecture));
        }
        console.log(`[ImportWorker] retry-failed-chunks: chunk=${failedChunk.chunkIndex}/${failedChunk.totalChunks} recovered ${lectures.length} lecture(s)`);
      } catch (err) {
        console.error(`[ImportWorker] retry-failed-chunks: chunk=${failedChunk.chunkIndex}/${failedChunk.totalChunks} failed again:`, err.message);
        stillFailed.push({ ...failedChunk, errorMessage: err.message });
      }
    }
    const recoveredLectures = recoveredLecturesForBackfill.length;

    if (recoveredLecturesForBackfill.length && panels.length) {
      const { backfilledCount } = await backfillLecturesFromLegend(recoveredLecturesForBackfill, panels, pool);
      if (backfilledCount > 0) {
        console.log(`[ImportWorker] retry-failed-chunks: legend-backfilled ${backfilledCount} recovered lecture(s)`);
      }
    }

    await pool.query(`UPDATE timetable_import_files SET failed_chunks = $1 WHERE id = $2`, [
      JSON.stringify(stillFailed),
      fileId,
    ]);

    if (stillFailed.length > 0) {
      await logEvent(
        jobId,
        'CHUNK_EXTRACTION_INCOMPLETE',
        `Retry recovered ${recoveredLectures} lecture(s); ${stillFailed.length} of ${failedChunks.length} section(s) still could not be processed`,
        null,
        fileId
      );
    } else {
      await logEvent(jobId, 'FILE_COMPLETED', `Retry recovered all ${recoveredLectures} previously-missing lecture(s)`, null, fileId);
    }
  } catch (err) {
    console.error(`[ImportWorker] retry-failed-chunks: unexpected error for file ${fileId}:`, err.message);
    await logEvent(jobId, 'ERROR', `Retrying failed chunks errored: ${err.message}`, null, fileId);
  }
}

async function processJob(job) {
  switch (job.name) {
    case 'process-import':
      return processImportJob(job.data);
    case 'generate-bookings':
      return processBookingGeneration(job.data);
    case 'retry-failed-chunks':
      return processRetryFailedChunks(job.data);
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

  // Catches jobs left stuck at PROCESSING/APPROVED by a worker that crashed
  // or was force-restarted mid-job in a previous run (see
  // services/importReconciliation.js) — then keeps sweeping periodically.
  startReconciliationSweep();

  console.log('📥 Timetable import worker started');
  return worker;
}

// Standalone entry point — runs only when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startImportPipelineWorker();
}
