import { Router } from "express";
import * as offerings from "../../services/planner/offerings.js";
import { ok } from "./respond.js";
import { emitRevBumps } from "./emit.js";

const r = Router();

r.get("/terms/:id/offerings", async (req, res) =>
  ok(res, { offerings: await offerings.listOfferings(req.params.id, req.query) }));
r.post("/terms/:id/offerings", async (req, res) =>
  ok(res, { offering: await offerings.createOffering(req.params.id, req.body) }, 201));
r.patch("/terms/:id/offerings/:oid", async (req, res) =>
  ok(res, { offering: await offerings.updateOffering(req.params.id, req.params.oid, req.body) }));
// Replaces the whole faculty set of the offering; answers with the refreshed offering.
r.put("/terms/:id/offerings/:oid/faculty", async (req, res) =>
  ok(res, { offering: await offerings.putOfferingFaculty(req.params.id, req.params.oid, req.body) }));
r.delete("/terms/:id/offerings/:oid", async (req, res) => {
  emitRevBumps(req, await offerings.deleteOffering(req.params.id, req.params.oid));
  ok(res);
});

export default r;
