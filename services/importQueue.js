// services/importQueue.js — mirrors the pattern in services/emailQueue.js
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

// BullMQ requires ioredis with maxRetriesPerRequest: null
const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

connection.on('error', (err) => console.error('❌ BullMQ Redis error (timetable-import):', err));

export const importQueue = new Queue('timetable-import', { connection });

const JOB_OPTIONS = {
  attempts: 1, // the worker handles its own retries internally (LLM calls, etc.)
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
};

export async function enqueueImportJob(jobId) {
  return importQueue.add('process-import', { jobId }, JOB_OPTIONS);
}

export async function enqueueBookingGeneration(jobId) {
  return importQueue.add('generate-bookings', { jobId }, JOB_OPTIONS);
}
