import { Router } from "express";
import * as subjects from "../../services/planner/subjects.js";
import { ok } from "./respond.js";

const r = Router();

r.get("/terms/:id/subjects", async (req, res) => ok(res, { subjects: await subjects.listSubjects(req.params.id) }));
r.post("/terms/:id/subjects", async (req, res) =>
  ok(res, { subject: await subjects.createSubject(req.params.id, req.body) }, 201));
r.patch("/terms/:id/subjects/:sid", async (req, res) =>
  ok(res, { subject: await subjects.updateSubject(req.params.id, req.params.sid, req.body) }));
r.delete("/terms/:id/subjects/:sid", async (req, res) => {
  await subjects.deleteSubject(req.params.id, req.params.sid);
  ok(res);
});

export default r;
