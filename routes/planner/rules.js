// Rule configuration of a term (contract 9.7). No version bump.
import { Router } from "express";
import { pool } from "../../services/planner/tx.js";
import * as rules from "../../services/planner/rules.js";
import { ok } from "./respond.js";

const r = Router();

r.get("/terms/:id/rules", async (req, res) => ok(res, { rules: await rules.loadRules(pool, req.params.id) }));
r.patch("/terms/:id/rules", async (req, res) => ok(res, { rules: await rules.patchRules(pool, req.params.id, req.body) }));
r.post("/terms/:id/rules/reset", async (req, res) => ok(res, { rules: await rules.resetRules(pool, req.params.id) }));

export default r;
