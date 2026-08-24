// services/importReconciliation.js
//
// If the worker process crashes or is force-restarted mid-job (confirmed
// reproducible during test-1 step 3: a Redis ECONNRESET/ENOTFOUND blip left
// a job's DB row at status='PROCESSING' forever, with nothing left running
// to ever update it), nothing else currently notices. This reconciles
// stale "PROCESSING" DB rows against BullMQ's own view of the job — run
// once at worker startup (catches rows left over from a previous crashed
// process) and on an interval (catches anything stuck during this
// instance's own lifetime, belt-and-suspenders alongside the Phase 1/2
// timeout and cancellation fixes).
import pool from '../database/db.js';
import { importQueue } from './importQueue.js';
import { markFailed } from './importProgress.js';

const ACTIVE_STATES = new Set(['active', 'waiting', 'delayed', 'waiting-children', 'prioritized']);

export async function reconcileStaleProcessingJobs() {
  // APPROVED is the equivalent in-flight state for the separate
  // 'generate-bookings' BullMQ job (booking generation) — same risk, same
  // reconciliation mechanism, so it's covered here too.
  const staleRes = await pool.query(`SELECT id FROM timetable_import_jobs WHERE status IN ('PROCESSING', 'APPROVED')`);
  if (!staleRes.rows.length) return;

  for (const { id: jobId } of staleRes.rows) {
    try {
      const job = await importQueue.getJob(jobId);
      const state = job ? await job.getState() : null;
      if (state && ACTIVE_STATES.has(state)) continue; // BullMQ agrees it's genuinely in progress

      const err = new Error(
        job
          ? `Reconciliation: BullMQ reports job state "${state}" but the DB still shows PROCESSING — the worker likely crashed or restarted mid-job`
          : 'Reconciliation: no matching BullMQ job found — the worker likely crashed or restarted before completing it, and the DB still shows PROCESSING'
      );
      err.name = 'ReconciliationError';
      const failureCode = await markFailed(jobId, err);
      console.error(`[Reconciliation] job=${jobId} marked failed code=${failureCode}: ${err.message}`);
    } catch (err) {
      console.error(`[Reconciliation] Failed to reconcile job ${jobId}:`, err.message);
    }
  }
}

let intervalHandle = null;

export function startReconciliationSweep(intervalMs = 5 * 60 * 1000) {
  reconcileStaleProcessingJobs().catch((err) => console.error('[Reconciliation] Startup sweep failed:', err.message));
  intervalHandle = setInterval(() => {
    reconcileStaleProcessingJobs().catch((err) => console.error('[Reconciliation] Periodic sweep failed:', err.message));
  }, intervalMs);
  intervalHandle.unref(); // don't keep the process alive just for this
  return intervalHandle;
}

export function stopReconciliationSweep() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}
