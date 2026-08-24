import 'dotenv/config';
import fs from 'fs/promises';
import pool from '../database/db.js';
import { enqueueImportJob } from '../services/importQueue.js';

const ADMIN_ID = '2a2be2e9-2731-4635-8491-7d6bb9ad9e3c';
const TEST_FILE = 'C:\\Users\\Aditya\\Downloads\\code\\web\\VY\\TimeTable_Data\\Sem3-SY-Class TT-All .xlsx';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const jobRes = await pool.query(
  `INSERT INTO timetable_import_jobs (name, created_by) VALUES ($1, $2) RETURNING id`,
  ['Structural-extraction-fix verification run', ADMIN_ID]
);
const jobId = jobRes.rows[0].id;

const stat = await fs.stat(TEST_FILE);
const fileRes = await pool.query(
  `INSERT INTO timetable_import_files (job_id, original_filename, storage_path, mime_type, file_size_bytes)
   VALUES ($1, $2, $3, $4, $5) RETURNING id`,
  [jobId, 'Sem3-SY-Class TT-All.xlsx', TEST_FILE, XLSX_MIME, stat.size]
);

await pool.query(`UPDATE timetable_import_jobs SET status = 'PROCESSING', updated_at = NOW() WHERE id = $1`, [jobId]);
await enqueueImportJob(jobId);

console.log(`JOB_ID=${jobId}`);
console.log(`FILE_ID=${fileRes.rows[0].id}`);
process.exit(0);
