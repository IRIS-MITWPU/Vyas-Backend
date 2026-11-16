// The planner router's Postgres error map: concurrency errors become a retryable 409.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KNOWN_PG_ERRORS, RETRY_MESSAGE } from "../../../routes/planner/errorMap.js";

test("deadlock, serialization failure and lock timeout map to 409 CONFLICT_RETRY with the plain message", () => {
  for (const code of ["40P01", "40001", "55P03"]) {
    assert.deepEqual(KNOWN_PG_ERRORS[code], [409, "CONFLICT_RETRY", "The timetable changed at the same time. Please try again."], code);
  }
  assert.equal(RETRY_MESSAGE, "The timetable changed at the same time. Please try again.");
});

test("the existing mappings are unchanged", () => {
  assert.equal(KNOWN_PG_ERRORS["23P01"][1], "CLASH");
  assert.equal(KNOWN_PG_ERRORS["23505"][1], "DUPLICATE");
  assert.equal(KNOWN_PG_ERRORS["23503"][1], "IN_USE");
  assert.equal(KNOWN_PG_ERRORS["22P02"][0], 404);
  for (const [status, , message] of Object.values(KNOWN_PG_ERRORS)) {
    assert.equal(typeof status, "number");
    assert.ok(message.length > 0 && !/pg_|constraint|relation/i.test(message), "no database wording reaches the client");
  }
});
