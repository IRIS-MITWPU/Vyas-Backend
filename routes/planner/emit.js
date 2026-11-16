// Live-sync emit helpers for the planner routes. Always called AFTER the transaction committed; an emit
// failure is logged and never fails the request.

/** Emits `planner:changed` to the room of payload.version_id (contract 8.3). */
export function emitPlannerChanged(req, payload) {
  try {
    req.app.get("io")?.to(`planner:version:${payload.version_id}`).emit("planner:changed", payload);
  } catch (err) {
    console.error("planner:changed emit failed:", err?.message); // never fails the request
  }
}

/** One refetch event per bumped version: `bumps` is [{version_id, prev_rev, rev}] (empty = nothing to emit). */
export function emitRevBumps(req, bumps) {
  for (const { version_id, prev_rev, rev } of bumps ?? []) {
    emitPlannerChanged(req, { version_id, rev, prev_rev, client_id: null, sessions: null, refetch: true });
  }
}
