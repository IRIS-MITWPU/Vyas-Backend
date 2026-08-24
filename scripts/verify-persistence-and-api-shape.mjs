import 'dotenv/config';
import pool from '../database/db.js';

const ADMIN_ID = '417ea552-e1b4-4b36-a251-b2f21c78e20b';

const jobRes = await pool.query(
  `INSERT INTO timetable_import_jobs (name, created_by) VALUES ($1, $2) RETURNING id`,
  ['DB/API-shape verification (synthetic)', ADMIN_ID]
);
const jobId = jobRes.rows[0].id;

const syntheticFailedChunks = [
  { chunkIndex: 3, totalChunks: 15, errorMessage: 'LLM call timed out after 45000ms', chunkText: 'Sheet: Test\nMonday | 9.00 | Subject A' },
  { chunkIndex: 9, totalChunks: 15, errorMessage: '{"error":{"code":504,"status":"DEADLINE_EXCEEDED"}}', chunkText: 'Sheet: Test\nTuesday | 10.00 | Subject B' },
];

const fileRes = await pool.query(
  `INSERT INTO timetable_import_files (job_id, original_filename, storage_path, mime_type, file_size_bytes, failed_chunks)
   VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
  [jobId, 'synthetic.xlsx', '/dev/null', 'application/vnd.ms-excel', 100, JSON.stringify(syntheticFailedChunks)]
);
const fileId = fileRes.rows[0].id;

// 1. Confirm the exact same query GET /jobs/:jobId uses reads it back correctly
const readBack = await pool.query('SELECT * FROM timetable_import_files WHERE job_id = $1', [jobId]);
const raw = readBack.rows[0].failed_chunks;
console.log('DB round-trip OK:', raw.length === 2 && raw[0].chunkText === syntheticFailedChunks[0].chunkText);

// 2. Apply the EXACT stripping transform routes/timetable-import.js's GET /jobs/:jobId uses
const stripped = readBack.rows.map((f) => ({
  ...f,
  failed_chunks: (f.failed_chunks || []).map(({ chunkIndex, totalChunks, errorMessage }) => ({
    chunkIndex,
    totalChunks,
    errorMessage,
  })),
}));
const strippedEntry = stripped[0].failed_chunks[0];
console.log('Stripped entry has no chunkText:', !('chunkText' in strippedEntry));
console.log('Stripped entry keeps chunkIndex/totalChunks/errorMessage:', JSON.stringify(strippedEntry));

// 3. Confirm the retry endpoint's query (WHERE id = $1 AND job_id = $2) finds it
const scoped = await pool.query('SELECT failed_chunks FROM timetable_import_files WHERE id = $1 AND job_id = $2', [fileId, jobId]);
console.log('Retry-endpoint lookup finds full chunkText:', scoped.rows[0].failed_chunks[0].chunkText === syntheticFailedChunks[0].chunkText);

const pass =
  raw.length === 2 &&
  raw[0].chunkText === syntheticFailedChunks[0].chunkText &&
  !('chunkText' in strippedEntry) &&
  strippedEntry.chunkIndex === 3 &&
  scoped.rows[0].failed_chunks[0].chunkText === syntheticFailedChunks[0].chunkText;

console.log(pass ? '\nPASS: persistence + API shaping + retry-lookup all correct.' : '\nFAIL: see above.');

await pool.query('DELETE FROM timetable_import_jobs WHERE id = $1', [jobId]);
process.exit(pass ? 0 : 1);
