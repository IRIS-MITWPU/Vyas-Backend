// Candidate slots and suggestions for one session (contract 9.4). Read-only, any version status.
import { Router } from "express";
import { z } from "zod";
import { pool } from "../../services/planner/tx.js";
import { parse } from "../../services/planner/validate.js";
import { notFound } from "../../services/planner/errors.js";
import { getSnapshot } from "../../services/planner/editor.js";
import { loadRules } from "../../services/planner/rules.js";
import { buildEngineConfig, buildModel, candidatesFor, suggestionsFor } from "../../services/planner/engine/index.js";
import { ok } from "./respond.js";

const r = Router();

const suggestionsQuery = z.object({
  limit: z
    .string()
    .regex(/^\d+$/, "must be a whole number between 1 and 20")
    .transform(Number)
    .pipe(z.number().int().min(1, "must be 1 or more").max(20, "must be 20 or less"))
    .optional(),
});

/** Snapshot + model + config of the version the session belongs to. 404 for an unknown session. */
async function loadForSession(sessionId) {
  const { rows } = await pool.query("SELECT version_id FROM planner_sessions WHERE id = $1", [sessionId]);
  if (!rows[0]) throw notFound("Session not found");
  const snapshot = await getSnapshot(rows[0].version_id);
  const rules = await loadRules(pool, snapshot.term.id);
  const model = buildModel(snapshot);
  if (!model.info.has(sessionId)) throw notFound("Session not found"); // deleted between the two reads
  return { rev: snapshot.rev, model, config: buildEngineConfig(rules) };
}

r.get("/sessions/:id/candidates", async (req, res) => {
  const { rev, model, config } = await loadForSession(req.params.id);
  ok(res, { rev, session_id: req.params.id, candidates: candidatesFor(model, req.params.id, config) });
});

r.get("/sessions/:id/suggestions", async (req, res) => {
  const { limit } = parse(suggestionsQuery, req.query);
  const { rev, model, config } = await loadForSession(req.params.id);
  ok(res, { rev, session_id: req.params.id, ...suggestionsFor(model, req.params.id, config, { limit: limit ?? 5 }) });
});

export default r;
