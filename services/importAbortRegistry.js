// services/importAbortRegistry.js
//
// The BullMQ import worker runs inline in the same process as the Express
// server (see app.js), so the POST /jobs/:jobId/stop handler can reach the
// worker's in-flight AbortController directly via this in-memory registry —
// no cross-process signaling needed. Only one chunk is ever in flight per
// job at a time (worker concurrency is 1, and chunks are processed
// sequentially), so a single controller per jobId is sufficient.

const activeControllers = new Map();

export function registerAbortController(jobId, controller) {
  if (jobId) activeControllers.set(jobId, controller);
}

export function unregisterAbortController(jobId) {
  if (jobId) activeControllers.delete(jobId);
}

/**
 * Aborts the in-flight LLM call for a job, if one is currently active.
 * Returns true if a controller was found and aborted, false otherwise (e.g.
 * the job is between chunks, or not an LLM stage at all — the existing
 * between-chunk isCancelled() checkpoint still catches those cases).
 */
export function abortActiveCall(jobId, reason) {
  const controller = activeControllers.get(jobId);
  if (!controller) return false;
  controller.abort(reason instanceof Error ? reason : new Error(reason || 'Aborted'));
  return true;
}
