// worker.js — background-jobs process (email + timetable-import + OTP sweep).
// Run as a separate container/process with `node worker.js`; the API then runs
// with RUN_WORKERS=false so a hostile import can't take the API down.
import "dotenv/config";

const REQUIRED_ENV = [
  "JWT_SECRET", "DB_USER", "DB_PASSWORD", "DB_HOST", "DB_NAME", "REDIS_URL",
  "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM",
  "S3_BUCKET", "AWS_REGION", "GEMINI_API_KEY",
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("❌ Missing required environment variables:", missing.join(", "));
  process.exit(1);
}

const { startEmailWorker } = await import("./workers/emailWorker.js");
const { startImportPipelineWorker } = await import("./workers/importPipelineWorker.js");
const { startOtpCleanupSweep } = await import("./services/otpCleanup.js");
const { default: pool } = await import("./database/db.js");

const emailWorker = startEmailWorker();
const importWorker = startImportPipelineWorker();
startOtpCleanupSweep();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — closing workers...`);
  setTimeout(() => process.exit(1), 10000).unref();
  try {
    await Promise.all([emailWorker.close(), importWorker.close()]);
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error("❌ Error during worker shutdown:", err);
    process.exit(1);
  }
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
