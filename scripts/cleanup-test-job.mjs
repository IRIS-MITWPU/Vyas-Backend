import 'dotenv/config';
import pool from '../database/db.js';

for (const jobId of process.argv.slice(2)) {
  await pool.query('DELETE FROM timetable_import_jobs WHERE id = $1', [jobId]);
  console.log(`Deleted test job ${jobId}`);
}
process.exit(0);
