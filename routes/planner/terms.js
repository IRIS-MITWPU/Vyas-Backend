import { Router } from "express";
import { requireFreshAuth } from "../../middlewares/authMiddleware.js";
import { logAuditEvent } from "../../services/auditLog.js";
import * as terms from "../../services/planner/terms.js";
import { ok } from "./respond.js";
import { emitRevBumps } from "./emit.js";

const r = Router();

r.get("/terms", async (req, res) => ok(res, { terms: await terms.listTerms() }));

r.post("/terms", async (req, res) => {
  const { term, version } = await terms.createTerm(req.body, req.user.id);
  logAuditEvent({
    actorUserId: req.user.id, action: "planner.term.create", targetType: "planner_term", targetId: term.id,
    metadata: { academic_year: term.academic_year, half: term.half, branch: term.branch },
  });
  ok(res, { term, version }, 201);
});

r.get("/terms/:id", async (req, res) => ok(res, await terms.getTerm(req.params.id)));

r.patch("/terms/:id", async (req, res) => {
  const { term, bumps } = await terms.updateTermWithBumps(req.params.id, req.body);
  emitRevBumps(req, bumps); // a building change may have unplaced sessions: open editors refetch
  ok(res, { term });
});

r.delete("/terms/:id", requireFreshAuth, async (req, res) => {
  const term = await terms.deleteTerm(req.params.id);
  logAuditEvent({
    actorUserId: req.user.id, action: "planner.term.delete", targetType: "planner_term", targetId: term.id,
    metadata: { academic_year: term.academic_year, half: term.half, branch: term.branch },
  });
  ok(res);
});

export default r;
