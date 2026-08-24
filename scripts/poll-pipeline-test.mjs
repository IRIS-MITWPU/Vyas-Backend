import 'dotenv/config';
import pool from '../database/db.js';

const jobId = process.argv[2];
const POLL_MS = 10000;
const MAX_WAIT_MS = 25 * 60 * 1000; // 25 min ceiling — generous given documented Gemini-side retry churn

const startedAt = Date.now();
while (Date.now() - startedAt < MAX_WAIT_MS) {
  const jr = await pool.query(
    'SELECT status, current_stage, progress_percent, current_chunk, total_chunks, current_attempt, retry_count, error_message, failure_code FROM timetable_import_jobs WHERE id = $1',
    [jobId]
  );
  const job = jr.rows[0];
  console.log(
    `[+${Math.round((Date.now() - startedAt) / 1000)}s] status=${job.status} stage=${job.current_stage} ` +
    `chunk=${job.current_chunk}/${job.total_chunks} attempt=${job.current_attempt} retries_so_far=${job.retry_count}`
  );
  if (['REVIEW_REQUIRED', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) {
    console.log('\n=== TERMINAL STATE REACHED ===');
    console.log(job);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}

console.log(`\nStill not terminal after ${MAX_WAIT_MS / 1000}s — worker process is untouched and left running, check again later.`);
process.exit(1);
