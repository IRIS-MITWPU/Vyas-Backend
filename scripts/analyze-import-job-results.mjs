import 'dotenv/config';
import pool from '../database/db.js';

const jobId = process.argv[2];

const total = await pool.query('SELECT COUNT(*) FROM timetable_extracted_lectures WHERE job_id = $1', [jobId]);
const totalCount = parseInt(total.rows[0].count);

const withMissing = await pool.query(
  `SELECT COUNT(*) FROM timetable_extracted_lectures WHERE job_id = $1 AND missing_fields IS NOT NULL AND array_length(missing_fields, 1) > 0`,
  [jobId]
);
const missingCount = parseInt(withMissing.rows[0].count);

const backfilled = await pool.query(
  `SELECT COUNT(*) FROM timetable_extracted_lectures WHERE job_id = $1 AND legend_backfilled = TRUE`,
  [jobId]
);
const backfilledCount = parseInt(backfilled.rows[0].count);

console.log(`Total lectures: ${totalCount}`);
console.log(`With missing_fields: ${missingCount} (${((missingCount / totalCount) * 100).toFixed(1)}%)`);
console.log(`Legend-backfilled: ${backfilledCount}`);

console.log('\n--- sample of 10 backfilled rows ---');
const sample = await pool.query(
  `SELECT raw_subject, raw_teacher_name, subject, teacher_name, room_number, panel_label, missing_fields
   FROM timetable_extracted_lectures WHERE job_id = $1 AND legend_backfilled = TRUE LIMIT 10`,
  [jobId]
);
for (const r of sample.rows) {
  console.log(`  panel="${r.panel_label}" raw_subject="${r.raw_subject}" -> subject="${r.subject}" teacher="${r.teacher_name}" room="${r.room_number}" missing=${JSON.stringify(r.missing_fields)}`);
}

console.log('\n--- batch field sanity: any malformed multi-division batches remaining? ---');
const badBatches = await pool.query(
  `SELECT raw_batch, batch, subject, room_number FROM timetable_extracted_lectures
   WHERE job_id = $1 AND (raw_batch LIKE '%,%' OR raw_batch LIKE '% %A%')  LIMIT 10`,
  [jobId]
);
console.log(`Rows with comma/multi-value-looking raw_batch: ${badBatches.rows.length}`);
for (const r of badBatches.rows) {
  console.log(`  raw_batch="${r.raw_batch}" batch="${r.batch}" subject="${r.subject}" room="${r.room_number}"`);
}

console.log('\n--- distinct missing_fields breakdown ---');
const breakdown = await pool.query(
  `SELECT missing_fields, COUNT(*) FROM timetable_extracted_lectures WHERE job_id = $1 AND missing_fields IS NOT NULL AND array_length(missing_fields,1) > 0 GROUP BY missing_fields ORDER BY COUNT(*) DESC LIMIT 15`,
  [jobId]
);
for (const r of breakdown.rows) {
  console.log(`  ${JSON.stringify(r.missing_fields)}: ${r.count}`);
}

console.log('\n--- checking for RECESS-like garbage rows (subject = R/C/E/S single letter) ---');
const garbage = await pool.query(
  `SELECT subject, raw_subject, weekday_number, start_time FROM timetable_extracted_lectures
   WHERE job_id = $1 AND (subject IN ('R','C','E','S') OR raw_subject IN ('R','C','E','S'))`,
  [jobId]
);
console.log(`Garbage single-letter-subject rows: ${garbage.rows.length}`);
for (const r of garbage.rows.slice(0, 10)) console.log(' ', r);

process.exit(0);
