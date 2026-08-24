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
  return importQueue.add('process-import', { jobId }, { ...JOB_OPTIONS, jobId });
}

export async function enqueueBookingGeneration(jobId) {
  return importQueue.add('generate-bookings', { jobId }, { ...JOB_OPTIONS, jobId });
}

// Uses a composite BullMQ job id (not the bare jobId 'process-import' and
// 'generate-bookings' both reuse on this same queue) so a retry request
// can't collide with either of those — scoped per file since retries are
// requested per file, not per job.
export async function enqueueRetryFailedChunks(jobId, fileId) {
  const bullJobId = `${jobId}:retry-failed-chunks:${fileId}`;
  return importQueue.add('retry-failed-chunks', { jobId, fileId }, { ...JOB_OPTIONS, jobId: bullJobId });
}

// Removes a not-yet-started BullMQ job so it never runs at all. Used when an
// admin stops a job that's still queued (worker hasn't picked it up yet, so
// there's no running loop to check cancel_requested).
export async function tryRemoveUnstartedQueueJob(jobId) {
  const job = await importQueue.getJob(jobId);
  if (!job) return false;
  const state = await job.getState();
  if (state === 'waiting' || state === 'delayed') {
    await job.remove();
    return true;
  }
  return false;
}
