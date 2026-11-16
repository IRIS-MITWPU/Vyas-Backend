// Editor endpoints (Phase 2): consistent snapshot read and the atomic ops write.
import { Router } from "express";
import * as editor from "../../services/planner/editor.js";
import { ok } from "./respond.js";
import { emitPlannerChanged } from "./emit.js";

const r = Router();

r.get("/versions/:id/snapshot", async (req, res) => ok(res, await editor.getSnapshot(req.params.id)));

r.post("/versions/:id/ops", async (req, res) => {
  const result = await editor.applyOps(req.params.id, req.body, { actorId: req.user.id });
  // after COMMIT; only when something changed (rev moved)
  if (result.sessions.length > 0) {
    emitPlannerChanged(req, {
      version_id: req.params.id,
      rev: result.rev,
      prev_rev: result.prev_rev,
      client_id: req.body?.client_id ?? null,
      sessions: result.sessions,
      refetch: false,
    });
  }
  ok(res, result);
});

export default r;
