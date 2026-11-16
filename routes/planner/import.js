import { Router } from "express";
import { logAuditEvent } from "../../services/auditLog.js";
import * as importer from "../../services/planner/importer.js";
import { ok } from "./respond.js";

const r = Router();

r.get("/import-templates", (req, res) => ok(res, { templates: importer.importTemplates() }));

r.post("/terms/:id/import/:entity", async (req, res) => {
  const entity = importer.parseEntity(req.params.entity);
  const dryRun = importer.parseDryRun(req.query.dryRun);
  const result = await importer.runImport(req.params.id, entity, req.body, { dryRun });
  if (result.applied) {
    logAuditEvent({
      actorUserId: req.user.id, action: "planner.import.apply", targetType: "planner_term", targetId: req.params.id,
      metadata: { entity, summary: result.summary },
    });
  }
  ok(res, result);
});

export default r;
