import { Router } from "express";
import * as faculty from "../../services/planner/faculty.js";
import { ok } from "./respond.js";

const r = Router();

r.get("/faculty", async (req, res) => ok(res, { faculty: await faculty.listFaculty(req.query) }));
r.post("/faculty", async (req, res) => ok(res, { faculty: await faculty.createFaculty(req.body) }, 201));
r.patch("/faculty/:id", async (req, res) => ok(res, { faculty: await faculty.updateFaculty(req.params.id, req.body) }));
r.delete("/faculty/:id", async (req, res) => {
  await faculty.deleteFaculty(req.params.id);
  ok(res);
});

export default r;
