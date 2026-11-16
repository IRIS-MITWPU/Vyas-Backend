// Known Postgres SQLSTATEs -> [status, code, plain message] for the planner router's error handler.
// Postgres error text never reaches the client.
export const RETRY_MESSAGE = "The timetable changed at the same time. Please try again.";

export const KNOWN_PG_ERRORS = {
  "22P02": [404, "NOT_FOUND", "Not found"], // malformed uuid in a path
  "23P01": [409, "CLASH", "That slot was just taken by another change. Refresh and try again."], // exclusion backstop
  "23505": [409, "DUPLICATE", "That already exists"],
  "23503": [409, "IN_USE", "That is still referenced by other records"],
  "23514": [400, "VALIDATION_ERROR", "A value is out of range"],
  "22003": [400, "VALIDATION_ERROR", "A number is out of range"],
  "23502": [400, "VALIDATION_ERROR", "A required value is missing"],
  // concurrency: the request lost a race (deadlock / serialization failure) or waited too long for a row lock
  "40P01": [409, "CONFLICT_RETRY", RETRY_MESSAGE], // deadlock_detected
  "40001": [409, "CONFLICT_RETRY", RETRY_MESSAGE], // serialization_failure
  "55P03": [409, "CONFLICT_RETRY", RETRY_MESSAGE], // lock_not_available (lock_timeout)
};
