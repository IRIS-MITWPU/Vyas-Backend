// Planner API errors. Services throw PlannerError; the planner router's error
// handler (routes/planner/index.js) turns it into { success:false, error, code, details? }.

export class PlannerError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "PlannerError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what = "Not found") => new PlannerError(404, "NOT_FOUND", what);
export const duplicate = (message) => new PlannerError(409, "DUPLICATE", message);
export const inUse = (message, details) => new PlannerError(409, "IN_USE", message, details);
export const placedSessions = (message, details) => new PlannerError(409, "HAS_PLACED_SESSIONS", message, details);
export const invalid = (message, fieldErrors = {}) =>
  new PlannerError(400, "VALIDATION_ERROR", message, { fieldErrors });

/** Runs fn; a Postgres unique violation (23505) becomes a 409 DUPLICATE with `message`. */
export async function orDuplicate(message, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err?.code === "23505") throw duplicate(message);
    throw err;
  }
}

// ---- Phase 2 (editor) factories ----
export const lockedByPlacements = (message, details) => new PlannerError(409, "LOCKED_BY_PLACEMENTS", message, details);
export const sessionLocked = (opIndex) =>
  new PlannerError(409, "SESSION_LOCKED", "This session is locked. Unlock it before changing it.", { op_index: opIndex });
export const placementInvalid = (message, reason, opIndex) =>
  new PlannerError(422, "PLACEMENT_INVALID", message, { op_index: opIndex, reason });
export const noRoomAvailable = (message, opIndex) => new PlannerError(409, "NO_ROOM_AVAILABLE", message, { op_index: opIndex });
export const notDraft = () => new PlannerError(409, "NOT_DRAFT", "Only a draft version can be edited");
/** conflicts: [{kind, resource_id, resource_name, session_id, text}]; the message is the first sentence. */
export const clash = (conflicts, opIndex) =>
  new PlannerError(409, "CLASH", conflicts[0].text, { op_index: opIndex, conflicts });

// ---- Phase 3 (generation) factories ----
export const generationRunning = (runId) =>
  new PlannerError(409, "GENERATION_RUNNING", "A timetable generation is already running for this version", { run_id: runId });
export const notReady = (errors) =>
  new PlannerError(422, "NOT_READY", "The term setup still has errors. Fix them before generating.", { errors });
export const notUndoable = (message = "This generation cannot be undone") => new PlannerError(409, "NOT_UNDOABLE", message);
export const runNotFound = () => new PlannerError(404, "RUN_NOT_FOUND", "Generation run not found");
export const runNotActive = () => new PlannerError(409, "RUN_NOT_ACTIVE", "This generation has already finished");
export const confirmRequired = () =>
  new PlannerError(422, "CONFIRM_REQUIRED", "Regenerating replaces every unlocked placed session. Send confirm: true to continue.");
