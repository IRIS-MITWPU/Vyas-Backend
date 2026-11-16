// worker_threads entry point of a generation run (contract 9.1.8). Pure CPU work: runs the engine on the data it was
// given and posts {type:'progress',stage,pct} / {type:'result',result} / {type:'error',code,message}. No DB, no I/O.
// Spawned by generationRunner.js; the thread is terminated on cancel / timeout.
import { parentPort, workerData } from "node:worker_threads";
import { generate } from "./engine/index.js";

if (parentPort) {
  try {
    const { snapshot, rules, params } = workerData;
    let last = 0;
    let lastStage = null;
    const result = generate({
      snapshot,
      rules,
      mode: params.mode,
      divisionIds: params.divisionIds ?? null,
      seeds: params.seeds,
      seed: params.seed,
      onProgress: (stage, pct) => {
        const now = Date.now();
        if (stage === lastStage && now - last < 100) return; // coalesce; the main thread throttles DB writes anyway
        last = now;
        lastStage = stage;
        parentPort.postMessage({ type: "progress", stage, pct });
      },
    });
    parentPort.postMessage({ type: "result", result });
  } catch (err) {
    parentPort.postMessage({ type: "error", code: err?.code ?? null, message: err?.message ?? String(err) });
  }
}
