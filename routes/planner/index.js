// /planner router (Timetable Planner, Phase 1).
//
// Feature flag: PLANNER_ENABLED is read on every request (not at boot). With anything other than
// "true" the whole router answers 404, before auth, so it looks like a route that does not exist.
// Every route then requires a signed-in admin; DELETE /terms/:id additionally requires fresh auth.
import { Router } from "express";
import { protect, adminOnly } from "../../middlewares/authMiddleware.js";
import { buildErrorBody } from "../../utils/errorResponse.js";
import { plannerLimiter } from "../../middlewares/rateLimiter.js";
import { PlannerError } from "../../services/planner/errors.js";
import { KNOWN_PG_ERRORS } from "./errorMap.js";
import termsRoutes from "./terms.js";
import facultyRoutes from "./faculty.js";
import subjectsRoutes from "./subjects.js";
import divisionsRoutes from "./divisions.js";
import offeringsRoutes from "./offerings.js";
import roomsRoutes from "./rooms.js";
import importRoutes from "./import.js";
import sessionsRoutes from "./sessions.js";
import readinessRoutes from "./readiness.js";
import editorRoutes from "./editor.js";
import rulesRoutes from "./rules.js";
import diagnosticsRoutes from "./diagnostics.js";
import suggestionsRoutes from "./suggestions.js";
import generationRoutes from "./generation.js";

const router = Router();

router.use((req, res, next) => {
  if (process.env.PLANNER_ENABLED !== "true") return res.status(404).json({ success: false, error: "Not found" });
  next();
});

// Planner has its own (much higher) limit: the editor is chatty and generalLimiter skips /planner.
router.use(plannerLimiter);

router.use(protect, adminOnly);

router.get("/health", (req, res) => res.json({ success: true, module: "planner", user: req.user }));

router.use(termsRoutes);
router.use(facultyRoutes);
router.use(subjectsRoutes);
router.use(divisionsRoutes);
router.use(offeringsRoutes);
router.use(roomsRoutes);
router.use(importRoutes);
router.use(sessionsRoutes);
router.use(readinessRoutes);
router.use(editorRoutes);
router.use(rulesRoutes);
router.use(diagnosticsRoutes);
router.use(suggestionsRoutes);
router.use(generationRoutes);

router.use((req, res) => res.status(404).json({ success: false, error: "Not found", code: "NOT_FOUND" }));

// Error handler (Express 5 forwards rejected async handlers here). Postgres error text never reaches
// the client: known SQLSTATEs map to a generic message; anything else is a 500 built with
// buildErrorBody from utils/errorResponse.js (so `details` appears only outside production, like sendError).
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err instanceof PlannerError) {
    const body = { success: false, error: err.message, code: err.code };
    if (err.code === "IMPORT_HAS_ERRORS") {
      // the frontend client only exposes `details`, so the full result is there and at the top level
      body.dry_run = false;
      body.applied = false;
      body.summary = err.details.summary;
      body.rows = err.details.rows;
      body.details = { summary: err.details.summary, rows: err.details.rows };
    } else if (err.details !== undefined) {
      body.details = err.details;
    }
    return res.status(err.status).json(body);
  }
  const known = KNOWN_PG_ERRORS[err?.code];
  if (known) {
    console.error("Planner DB constraint:", err.code, err.constraint);
    return res.status(known[0]).json({ success: false, error: known[2], code: known[1] });
  }
  if (err?.status && err.status < 500) {
    return res.status(err.status).json({ success: false, error: "Bad request", code: "VALIDATION_ERROR" });
  }
  console.error("Planner error:", err);
  res.status(500).json({ success: false, code: "INTERNAL_ERROR", ...buildErrorBody("Internal server error", err) });
});

export default router;
