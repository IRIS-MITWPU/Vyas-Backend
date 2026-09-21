// services/extractionRunner.js
//
// Runs extractTextFromFile() in a worker thread with a heap cap and a
// wall-clock timeout, so a hostile upload (audit F5/F6/F7) can only kill its
// own extraction — not the import worker (or, when workers run in-process,
// the API). The same file is the thread entry point.
//
// resourceLimits only caps the JS heap. A PDF flate bomb inflates into
// typed arrays (external memory), which it does not cover — measured: a 1 MB
// PDF grew a 512 MB-limited thread to 1.8 GB RSS — so a watchdog also polls
// the thread's heap + external memory and terminates it past MEM_MB.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { extractTextFromFile } from './extractionService.js';

const HEAP_MB = parseInt(process.env.IMPORT_EXTRACT_HEAP_MB || '512');
const MEM_MB = parseInt(process.env.IMPORT_EXTRACT_MEM_MB || '768');
const TIMEOUT_MS = parseInt(process.env.IMPORT_EXTRACT_TIMEOUT_MS || '60000');

if (!isMainThread) {
  try {
    const result = await extractTextFromFile(Buffer.from(workerData.buffer), workerData.mimeType);
    parentPort.postMessage({ ok: true, result });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err.message });
  }
}

export function extractInWorker(buffer, mimeType, { heapMb = HEAP_MB, memMb = MEM_MB, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(fileURLToPath(import.meta.url), {
      workerData: { buffer, mimeType },
      execArgv: [], // don't inherit the parent's CLI flags (--input-type, --inspect, ...)
      resourceLimits: { maxOldGenerationSizeMb: heapMb },
    });
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      worker.terminate();
      fn(value);
    };
    const timer = setTimeout(
      () => settle(reject, new Error(`Text extraction timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    const watchdog = setInterval(async () => {
      try {
        const h = await worker.getHeapStatistics();
        if ((h.used_heap_size + h.external_memory) / 1048576 > memMb) {
          settle(reject, new Error('Text extraction exceeded its memory limit'));
        }
      } catch { /* thread already gone */ }
    }, 200);
    worker.once('message', (m) => (m.ok ? settle(resolve, m.result) : settle(reject, new Error(m.error))));
    worker.once('error', (err) =>
      settle(reject, new Error(err.code === 'ERR_WORKER_OUT_OF_MEMORY'
        ? 'Text extraction exceeded its memory limit'
        : `Text extraction failed: ${err.message}`))
    );
    worker.once('exit', (code) => settle(reject, new Error(`Text extraction worker exited (${code})`)));
  });
}
