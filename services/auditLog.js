import pool from "../database/db.js";

/**
 * Record a security-relevant event (see database/migrations/009_audit_events.sql).
 *
 * Deliberately fire-and-forget: it is NOT awaited by callers and never throws,
 * so an audit-table problem can't fail a login or block a response. That means
 * it is a best-effort trail for incident reconstruction, not a guaranteed
 * ledger — don't build authorization decisions on top of it.
 *
 * ponytail: an un-awaited insert, not a BullMQ job. BullMQ is already in the
 * stack, but a queue here buys a worker and a new failure mode to avoid one
 * non-blocking INSERT. Move it onto the queue only if login latency measurably
 * suffers.
 */
export function logAuditEvent({ actorUserId = null, action, targetType = null, targetId = null, metadata = {} }) {
  pool
    .query(
      `INSERT INTO audit_events (actor_user_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [actorUserId, action, targetType, targetId, metadata]
    )
    .catch((err) => console.error("Audit log write failed:", action, err.message));
}
