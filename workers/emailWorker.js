// workers/emailWorker.js
//
// Can be started inline (via startEmailWorker()) or as a standalone process:
//   node workers/emailWorker.js
//
import "dotenv/config";
import { fileURLToPath } from "url";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import {
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendBookingConfirmationEmail,
  sendVerificationEmail,
} from "../services/emailService.js";
import { decryptOtp } from "../utils/otpCrypto.js";

async function processEmail(job) {
  switch (job.name) {
    case "welcome":
      await sendWelcomeEmail(job.data.to, job.data.fullName);
      break;

    case "password-reset":
      await sendPasswordResetEmail(job.data.to, job.data.resetUrl);
      break;

    case "booking-confirmation":
      await sendBookingConfirmationEmail(job.data);
      break;

    case "verification-code":
      await sendVerificationEmail(
        job.data.to,
        job.data.fullName,
        decryptOtp(job.data.encryptedCode),
        job.data.expiresInMinutes
      );
      break;

    default:
      throw new Error(`Unknown email job type: "${job.name}"`);
  }
}

export function startEmailWorker() {
  const connection = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
  });

  const worker = new Worker("emails", processEmail, {
    connection,
    concurrency: Number(process.env.EMAIL_WORKER_CONCURRENCY) || 3,
  });

  worker.on("completed", (job) => {
    console.log(`✅ Email job ${job.id} (${job.name}) completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(
      `❌ Email job ${job?.id} (${job?.name}) failed` +
        ` — attempt ${job?.attemptsMade}/${job?.opts?.attempts}: ${err.message}`
    );
  });

  worker.on("error", (err) => {
    console.error("❌ Email worker error:", err);
  });

  console.log("📬 Email worker started");
  return worker;
}

// Standalone entry point — runs only when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startEmailWorker();
}
