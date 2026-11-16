import { Router } from "express";
import * as divisions from "../../services/planner/divisions.js";
import { ok } from "./respond.js";
import { emitRevBumps } from "./emit.js";

const r = Router();

r.get("/terms/:id/divisions", async (req, res) => ok(res, { divisions: await divisions.listDivisions(req.params.id) }));
r.post("/terms/:id/divisions", async (req, res) =>
  ok(res, { division: await divisions.createDivision(req.params.id, req.body) }, 201));
r.patch("/terms/:id/divisions/:did", async (req, res) =>
  ok(res, { division: await divisions.updateDivision(req.params.id, req.params.did, req.body) }));
r.delete("/terms/:id/divisions/:did", async (req, res) => {
  emitRevBumps(req, await divisions.deleteDivision(req.params.id, req.params.did));
  ok(res);
});

r.post("/terms/:id/divisions/:did/batches", async (req, res) =>
  ok(res, { batch: await divisions.createBatch(req.params.id, req.params.did, req.body) }, 201));
r.patch("/terms/:id/divisions/:did/batches/:bid", async (req, res) =>
  ok(res, { batch: await divisions.updateBatch(req.params.id, req.params.did, req.params.bid, req.body) }));
r.delete("/terms/:id/divisions/:did/batches/:bid", async (req, res) => {
  emitRevBumps(req, await divisions.deleteBatch(req.params.id, req.params.did, req.params.bid));
  ok(res);
});

export default r;
