// Runs the generator in a worker_threads thread (works with RUN_WORKERS=false, no BullMQ). The thread has a heap cap and
// an overall timeout; terminate() stops it (cancel). Mirrors services/extractionRunner.js.
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const HEAP_MB = parseInt(process.env.PLANNER_GENERATION_HEAP_MB || "1024", 10);
const TIMEOUT_MS = parseInt(process.env.PLANNER_GENERATION_TIMEOUT_MS || String(5 * 60 * 1000), 10);
const MAX_WORKERS = parseInt(process.env.PLANNER_GENERATION_MAX_WORKERS || "2", 10);

export class RunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
  }
}

// ---- process-wide cap on concurrent generation threads (contract 9.9): extra runs wait (they stay 'queued')
let maxWorkers = Number.isInteger(MAX_WORKERS) && MAX_WORKERS >= 1 ? MAX_WORKERS : 2;
let running = 0;
const waiters = [];

function makeRelease() {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    running -= 1;
    drain();
  };
}

function drain() {
  while (running < maxWorkers && waiters.length) {
    const w = waiters.shift();
    running += 1;
    if (w.handle) w.handle.abortWait = null;
    w.resolve(makeRelease());
  }
}

/**
 * Waits for a free generation slot (FIFO) and resolves with a release() function (idempotent). While waiting,
 * `handle.abortWait()` rejects the wait with RunnerError CANCELLED (a queued run being cancelled).
 */
export function acquireWorkerSlot(handle = null) {
  return new Promise((resolve, reject) => {
    if (running < maxWorkers && !waiters.length) {
      running += 1;
      resolve(makeRelease());
      return;
    }
    const w = { resolve, handle };
    waiters.push(w);
    if (handle) {
      handle.abortWait = () => {
        const k = waiters.indexOf(w);
        if (k < 0) return;
        waiters.splice(k, 1);
        handle.abortWait = null;
        reject(new RunnerError("CANCELLED", "cancelled while waiting for a free slot"));
      };
    }
  });
}

/** {running, waiting, max} of the process-wide slots; setMaxWorkers is for tests. */
export const workerSlots = () => ({ running, waiting: waiters.length, max: maxWorkers });
export function setMaxWorkers(n) {
  maxWorkers = Math.max(1, Math.floor(n));
  drain();
}

/**
 * @param payload {snapshot, rules, params:{mode, divisionIds, seeds, seed}}
 * @returns {{promise: Promise<object>, terminate: (reason?: string) => void}}
 *   promise resolves with the engine result; rejects with RunnerError code CANCELLED | GENERATION_TIMEOUT | GENERATION_FAILED.
 */
export function startGeneration(payload, { onProgress, timeoutMs = TIMEOUT_MS, heapMb = HEAP_MB } = {}) {
  const worker = new Worker(fileURLToPath(new URL("./generationWorker.js", import.meta.url)), {
    workerData: payload,
    execArgv: [], // do not inherit the parent's CLI flags
    resourceLimits: { maxOldGenerationSizeMb: heapMb },
  });
  let settled = false;
  let settleFn;
  let rejectFn;
  const promise = new Promise((resolve, reject) => {
    rejectFn = reject;
    settleFn = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(
      () => settleFn(reject, new RunnerError("GENERATION_TIMEOUT", "The timetable generation took too long and was stopped.")),
      timeoutMs
    );
    timer.unref?.();
    worker.on("message", (m) => {
      if (m?.type === "progress") {
        try {
          onProgress?.(m.stage, m.pct);
        } catch {
          /* progress is best effort */
        }
      } else if (m?.type === "result") settleFn(resolve, m.result);
      else if (m?.type === "error") {
        settleFn(reject, m.code === "CANCELLED" ? new RunnerError("CANCELLED", m.message) : new RunnerError("GENERATION_FAILED", m.message));
      }
    });
    worker.on("error", (err) =>
      settleFn(
        reject,
        new RunnerError("GENERATION_FAILED", err?.code === "ERR_WORKER_OUT_OF_MEMORY" ? "The generation ran out of memory." : `The generation failed: ${err?.message}`)
      )
    );
    worker.on("exit", (code) => settleFn(reject, new RunnerError("GENERATION_FAILED", `The generation worker stopped unexpectedly (${code}).`)));
  });
  return {
    promise,
    terminate: () => settleFn(rejectFn, new RunnerError("CANCELLED", "The generation was cancelled.")),
  };
}
