import pool from "../../database/db.js";

/**
 * Runs fn(client) inside one transaction: BEGIN, COMMIT on success, ROLLBACK on any
 * throw (the error is re-thrown), and always releases the client.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("Planner rollback failed:", rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

export { pool };
