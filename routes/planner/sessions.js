import { Router } from "express";
import { logAuditEvent } from "../../services/auditLog.js";
import * as sessions from "../../services/planner/sessions.js";
import { ok } from "./respond.js";
import { emitPlannerChanged } from "./emit.js";

const r = Router();

r.post("/versions/:id/sync-sessions", async (req, res) => {
  const { term_id, prev_rev, ...result } = await sessions.syncSessions(req.params.id);
  logAuditEvent({
    actorUserId: req.user.id, action: "planner.sessions.sync", targetType: "planner_version", targetId: req.params.id,
    metadata: { term_id, added: result.added, removed: result.removed, kept: result.kept, faculty_updated: result.faculty_updated },
  });
  if (result.rev !== prev_rev) {
    emitPlannerChanged(req, { version_id: req.params.id, rev: result.rev, prev_rev, client_id: null, sessions: null, refetch: true });
  }
  ok(res, result);
});

r.get("/versions/:id/sessions/summary", async (req, res) => ok(res, await sessions.sessionsSummary(req.params.id)));
r.get("/versions/:id/sessions", async (req, res) =>
  ok(res, { sessions: await sessions.listSessions(req.params.id, req.query) }));

export default r;
