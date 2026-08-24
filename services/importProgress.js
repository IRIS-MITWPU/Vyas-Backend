// services/importProgress.js
import pool from '../database/db.js';

const STAGE_WEIGHTS = {
  QUEUED: 0, READING_FILE: 10, OCR: 20, CALLING_LLM: 60,
  BACKFILLING_LEGEND: 5, CORRELATING: 5, DETECTING_CONFLICTS: 5, GENERATING_BOOKINGS: 0, DONE: 100,
};

export const FAILURE_CODES = {
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  LLM_PROVIDER_ERROR: 'LLM_PROVIDER_ERROR',
  LLM_RETRIES_EXHAUSTED: 'LLM_RETRIES_EXHAUSTED',
  JOB_CANCELLED_BY_USER: 'JOB_CANCELLED_BY_USER',
  JOB_DEADLINE_EXCEEDED: 'JOB_DEADLINE_EXCEEDED',
  REDIS_ERROR: 'REDIS_ERROR',
  PARSING_ERROR: 'PARSING_ERROR',
  UNKNOWN: 'UNKNOWN',
};

/**
 * Best-effort mapping from a caught error to a failureCode, so every
 * terminal state is distinguishable by cause instead of just a free-text
 * error_message. Order matters — most specific checks first.
 */
export function classifyFailure(err) {
  if (!err) return FAILURE_CODES.UNKNOWN;
  if (err.name === 'UserCancelledError') return FAILURE_CODES.JOB_CANCELLED_BY_USER;
  if (err.name === 'TimeoutError') return FAILURE_CODES.LLM_TIMEOUT;
  if (err.name === 'DeadlineExceededError') return FAILURE_CODES.JOB_DEADLINE_EXCEEDED;
  if (typeof err.message === 'string' && err.message.startsWith('LLM extraction failed after')) {
    return FAILURE_CODES.LLM_RETRIES_EXHAUSTED;
  }
  if (
    typeof err.message === 'string' &&
    (err.message.includes('LLM returned invalid JSON') || err.message.includes('missing "lectures" array'))
  ) {
    return FAILURE_CODES.PARSING_ERROR;
  }
  if (err.code === 'ECONNRESET' || err.code === 'ENOTFOUND' || /redis/i.test(err.message || '')) {
    return FAILURE_CODES.REDIS_ERROR;
  }
  if (err.retryable === false && err.status) return FAILURE_CODES.LLM_PROVIDER_ERROR;
  return FAILURE_CODES.UNKNOWN;
}

/**
 * Marks a job as terminally failed with a distinguishable failureCode — used
 * by the worker's top-level catch blocks so no path leaves a job silently
 * stuck at a non-terminal status on an unhandled exception.
 */
export async function markFailed(jobId, err) {
  const failureCode = classifyFailure(err);
  await pool.query(
    `UPDATE timetable_import_jobs
     SET status = 'FAILED', failure_code = $1, error_message = $2, current_stage = 'DONE', updated_at = NOW()
     WHERE id = $3`,
    [failureCode, err?.message ?? String(err), jobId]
  );
  return failureCode;
}

/**
 * Per-chunk/per-attempt progress, for observability — lets "is this job
 * actually stuck or legitimately processing" be answered from the DB
 * without guessing from timestamps alone.
 */
export async function updateLlmProgress(jobId, { currentChunk, totalChunks, currentAttempt, maxAttempts, retryIncrement } = {}) {
  const fields = ['last_progress_at = NOW()'];
  const values = [];
  let i = 1;
  if (currentChunk !== undefined) { fields.push(`current_chunk = $${i++}`); values.push(currentChunk); }
  if (totalChunks !== undefined) { fields.push(`total_chunks = $${i++}`); values.push(totalChunks); }
  if (currentAttempt !== undefined) { fields.push(`current_attempt = $${i++}`); values.push(currentAttempt); }
  if (maxAttempts !== undefined) { fields.push(`max_attempts = $${i++}`); values.push(maxAttempts); }
  if (retryIncrement) fields.push('retry_count = retry_count + 1');
  values.push(jobId);
  await pool.query(`UPDATE timetable_import_jobs SET ${fields.join(', ')} WHERE id = $${i}`, values);
}

export async function markLlmRequestStarted(jobId) {
  await pool.query(
    `UPDATE timetable_import_jobs SET llm_request_started_at = NOW(), last_progress_at = NOW() WHERE id = $1`,
    [jobId]
  );
}

export async function markProcessingStarted(jobId) {
  await pool.query(`UPDATE timetable_import_jobs SET processing_started_at = NOW() WHERE id = $1`, [jobId]);
}

export async function setStage(jobId, stage, { fileId = null, filesTotal, filesCompleted } = {}) {
  const percent = computePercent(stage, filesTotal, filesCompleted);
  await pool.query(
    `UPDATE timetable_import_jobs
     SET current_stage = $1, current_file_id = $2,
         files_total = COALESCE($3, files_total),
         files_completed = COALESCE($4, files_completed),
         progress_percent = $5, updated_at = NOW()
     WHERE id = $6`,
    [stage, fileId, filesTotal ?? null, filesCompleted ?? null, percent, jobId]
  );
  await logEvent(jobId, 'STAGE_CHANGE', `Stage: ${stage}`, null, fileId);
}

export async function logEvent(jobId, eventType, message, detail = null, fileId = null) {
  await pool.query(
    `INSERT INTO timetable_import_job_events (job_id, event_type, file_id, message, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [jobId, eventType, fileId, message, detail ? JSON.stringify(detail) : null]
  );
}

export async function isCancelled(jobId) {
  const res = await pool.query(`SELECT cancel_requested FROM timetable_import_jobs WHERE id = $1`, [jobId]);
  return res.rows[0]?.cancel_requested === true;
}

export async function handleCancellation(jobId) {
  await pool.query(
    `UPDATE timetable_import_jobs
     SET status = 'CANCELLED', failure_code = $1, current_stage = 'DONE', stopped_at = NOW(), updated_at = NOW()
     WHERE id = $2`,
    [FAILURE_CODES.JOB_CANCELLED_BY_USER, jobId]
  );
  await logEvent(jobId, 'STOPPED', 'Processing stopped by admin request');
}

// Simple + monotonic: 90% budget split across files completed, remainder
// from how far the current file has gotten through its stages. 100 is
// reserved for the explicit DONE call.
function computePercent(stage, filesTotal, filesCompleted) {
  if (stage === 'DONE') return 100;
  const total = filesTotal || 1;
  const base = Math.floor(((filesCompleted || 0) / total) * 90);
  const stageBonus = Math.floor((STAGE_WEIGHTS[stage] || 0) / total / 100 * 90);
  return Math.min(99, base + stageBonus);
}
