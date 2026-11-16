// Live diagnostics of a version (contract 9.3). Computed on every request from one consistent snapshot (no cache).
import { Router } from "express";
import { pool } from "../../services/planner/tx.js";
import { getSnapshot } from "../../services/planner/editor.js";
import { loadRules } from "../../services/planner/rules.js";
import { evaluateAll } from "../../services/planner/engine/evaluate.js";
import { ok } from "./respond.js";

const r = Router();

r.get("/versions/:id/diagnostics", async (req, res) => {
  const snapshot = await getSnapshot(req.params.id);
  const rules = await loadRules(pool, snapshot.term.id);
  const { publishable, counts, by_division, issues } = evaluateAll(snapshot, rules);
  ok(res, { rev: snapshot.rev, publishable, counts, by_division, issues });
});

export default r;
