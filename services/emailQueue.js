// services/emailQueue.js
import { Queue } from "bullmq";
import IORedis from "ioredis";

// BullMQ requires ioredis with maxRetriesPerRequest: null
const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

connection.on("error", (err) => console.error("❌ BullMQ Redis error:", err));

export const emailQueue = new Queue("emails", { connection });

const JOB_OPTIONS = {
  attempts: Number(process.env.EMAIL_QUEUE_ATTEMPTS) || 5,
  backoff: { type: "exponential", delay: 2000 }, // 2s → 4s → 8s → 16s → 32s
  // Job data includes encrypted sign-in codes, and finished jobs stay readable
  // in Redis dumps and Bull Board. Keep them only as long as a code is valid (10 min).
  removeOnComplete: { age: 15 * 60, count: 10 },
  removeOnFail: { age: 15 * 60, count: 50 },
};

/**
 * Enqueue an outgoing email.
 * @param {"welcome"|"booking-confirmation"|"verification-code"} type
 * @param {object} payload  Data forwarded to the matching emailService function
 */
export async function enqueueEmail(type, payload) {
  return emailQueue.add(type, payload, JOB_OPTIONS);
}