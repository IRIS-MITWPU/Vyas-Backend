import 'dotenv/config';
import pool from '../database/db.js';

const jobId = process.argv[2];

const job = await pool.query('SELECT * FROM timetable_import_jobs WHERE id = $1', [jobId]);
console.log('=== JOB ===');
console.log(job.rows[0]);

const files = await pool.query('SELECT id, original_filename, extraction_status, ocr_used, failed_chunks, length(raw_text) as raw_text_len FROM timetable_import_files WHERE job_id = $1', [jobId]);
console.log('\n=== FILES ===');
console.log(files.rows);

const lectures = await pool.query('SELECT count(*) FROM timetable_extracted_lectures WHERE job_id = $1', [jobId]);
console.log('\n=== LECTURES SAVED ===', lectures.rows[0].count);

const events = await pool.query('SELECT event_type, message, created_at FROM timetable_import_job_events WHERE job_id = $1 ORDER BY created_at ASC', [jobId]);
console.log('\n=== EVENTS ===');
for (const e of events.rows) console.log(`${e.created_at.toISOString()} [${e.event_type}] ${e.message}`);

process.exit(0);
