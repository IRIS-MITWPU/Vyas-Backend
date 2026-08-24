import 'dotenv/config';
import fs from 'fs/promises';
import pool from '../database/db.js';
import { enqueueImportJob } from '../services/importQueue.js';

const ADMIN_ID = '417ea552-e1b4-4b36-a251-b2f21c78e20b';
const TEST_FILE = 'C:\\Users\\Aditya\\Downloads\\code\\web\\VY\\TimeTable_Data\\Vyas Block- Sem1-2026-27-All-Classrooms TT.xlsx';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const jobRes = await pool.query(
  `INSERT INTO timetable_import_jobs (name, created_by) VALUES ($1, $2) RETURNING id`,
  ['Pipeline test run 2 — Vyas Block Sem1', ADMIN_ID]
);
const jobId = jobRes.rows[0].id;

const stat = await fs.stat(TEST_FILE);
const fileRes = await pool.query(
  `INSERT INTO timetable_import_files (job_id, original_filename, storage_path, mime_type, file_size_bytes)
   VALUES ($1, $2, $3, $4, $5) RETURNING id`,
  [jobId, 'Vyas Block- Sem1-2026-27-All-Classrooms TT.xlsx', TEST_FILE, XLSX_MIME, stat.size]
);

await pool.query(`UPDATE timetable_import_jobs SET status = 'PROCESSING', updated_at = NOW() WHERE id = $1`, [jobId]);
await enqueueImportJob(jobId);

console.log(`JOB_ID=${jobId}`);
console.log(`FILE_ID=${fileRes.rows[0].id}`);
process.exit(0);
