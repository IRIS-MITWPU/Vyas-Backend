import { pool } from "./tx.js";
import { computeReadiness } from "./domain/index.js";
import { loadTermState } from "./state.js";

/** Readiness report of a term (404 when the term does not exist). */
export async function getReadiness(termId) {
  // One snapshot so the report is consistent even while someone edits.
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const state = await loadTermState(client, termId);
    await client.query("COMMIT");
    return computeReadiness(state);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
