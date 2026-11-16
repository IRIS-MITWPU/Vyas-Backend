// Generation runs (contract 9.6): start, list, poll, cancel and undo. The run itself executes in the background
// (worker thread); these routes only create/read the run row.
import { Router } from "express";
import { logAuditEvent } from "../../services/auditLog.js";
import * as generation from "../../services/planner/generation.js";
import { ok } from "./respond.js";

const r = Router();

r.post("/versions/:id/generate", async (req, res) => {
  const run = await generation.createRun(req.params.id, req.body, { actorId: req.user.id, io: req.app.get("io") });
  logAuditEvent({
    actorUserId: req.user.id, action: "planner.generation.start", targetType: "planner_version", targetId: req.params.id,
    metadata: { run_id: run.id, term_id: run.term_id, mode: run.mode, seeds: run.options?.seeds, division_ids: run.scope?.division_ids ?? null },
  });
  ok(res, { run }, 202);
});

r.get("/versions/:id/generation", async (req, res) => ok(res, await generation.listRuns(req.params.id)));
r.get("/generation-runs/:id", async (req, res) => ok(res, { run: await generation.getRun(req.params.id) }));
r.post("/generation-runs/:id/cancel", async (req, res) => ok(res, { run: await generation.cancelRun(req.params.id) }));

r.post("/generation-runs/:id/undo", async (req, res) => {
  const { rev, refused, ...result } = await generation.undoRun(req.params.id, { io: req.app.get("io") });
  logAuditEvent({
    actorUserId: req.user.id, action: "planner.generation.undo", targetType: "planner_generation_run", targetId: req.params.id,
    metadata: { version_id: result.run.version_id, restored: result.restored, skipped: result.skipped_session_ids.length },
  });
  ok(res, { ...result, refused });
});

export default r;
