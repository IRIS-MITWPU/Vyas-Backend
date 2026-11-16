import { Router } from "express";
import { getReadiness } from "../../services/planner/readiness.js";
import { ok } from "./respond.js";

const r = Router();

r.get("/terms/:id/readiness", async (req, res) => ok(res, await getReadiness(req.params.id)));

export default r;
