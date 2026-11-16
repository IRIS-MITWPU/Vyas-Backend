import { z } from "zod";
import { pool, withTransaction } from "./tx.js";
import { parse, failField, uuid } from "./validate.js";
import { notFound, duplicate, inUse, lockedByPlacements } from "./errors.js";
import { lockTermVersions } from "./guards.js";
import { requireTerm } from "./terms.js";

const addSchema = z.object({
  room_id: uuid.optional(),
  room_ids: z.array(uuid).min(1).max(500).optional(),
  is_lab: z.boolean().optional(),
});
const patchSchema = z.object({ is_lab: z.boolean({ error: "is required" }) });

const POOL_SELECT = `
  SELECT tr.id, tr.term_id, tr.room_id, tr.is_lab, r.name, b.name AS building_name, f.floor_number,
         r.room_type::text AS room_type, r.capacity
    FROM planner_term_rooms tr
    JOIN rooms r ON r.id = tr.room_id
    JOIN floors f ON f.id = r.floor_id
    JOIN buildings b ON b.id = f.building_id`;
const POOL_ORDER = "ORDER BY lower(b.name), f.floor_number, lower(r.name)";

/** Term room-pool rows joined with room info (also used to build the readiness state). */
export async function loadPoolRooms(db, termId) {
  const { rows } = await db.query(`${POOL_SELECT} WHERE tr.term_id = $1 ${POOL_ORDER}`, [termId]);
  return rows;
}

export async function listPool(termId) {
  await requireTerm(pool, termId);
  return loadPoolRooms(pool, termId);
}

/** All active Vyas rooms for the room-pool picker. */
export async function availableRooms() {
  const { rows } = await pool.query(
    `SELECT r.id, r.name, b.name AS building_name, f.floor_number, r.room_type::text AS room_type, r.capacity, r.is_active
       FROM rooms r JOIN floors f ON f.id = r.floor_id JOIN buildings b ON b.id = f.building_id
      WHERE r.is_active ${POOL_ORDER}`
  );
  return rows;
}

export async function addPoolRooms(termId, body) {
  const b = parse(addSchema, body);
  if (!b.room_id && !b.room_ids) failField("room_id", "room_id or room_ids is required");
  if (b.room_id && b.room_ids) failField("room_ids", "send either room_id or room_ids, not both");
  const single = Boolean(b.room_id);
  const ids = [...new Set(b.room_ids ?? [b.room_id])];

  const addedIds = await withTransaction(async (db) => {
    await requireTerm(db, termId, { lock: true });
    const { rows: rooms } = await db.query("SELECT id, room_type::text AS room_type FROM rooms WHERE id = ANY($1::uuid[])", [ids]);
    const byId = new Map(rooms.map((r) => [r.id, r]));
    ids.forEach((id, i) => {
      if (!byId.has(id)) failField(single ? "room_id" : `room_ids.${i}`, "room not found");
    });
    const { rows: existing } = await db.query("SELECT room_id FROM planner_term_rooms WHERE term_id = $1 AND room_id = ANY($2::uuid[])", [termId, ids]);
    if (single && existing.length) throw duplicate("This room is already in the term's room pool");
    const have = new Set(existing.map((r) => r.room_id));
    const added = [];
    for (const id of ids) {
      if (have.has(id)) continue;
      const isLab = b.is_lab ?? byId.get(id).room_type === "lab";
      const { rows: [row] } = await db.query(
        "INSERT INTO planner_term_rooms (term_id, room_id, is_lab) VALUES ($1,$2,$3) ON CONFLICT (term_id, room_id) DO NOTHING RETURNING id",
        [termId, id, isLab]
      );
      if (row) added.push(row.id);
    }
    return added;
  });
  const { rows } = addedIds.length
    ? await pool.query(`${POOL_SELECT} WHERE tr.id = ANY($1::uuid[]) ${POOL_ORDER}`, [addedIds])
    : { rows: [] };
  return { rooms: rows, room: single ? rows[0] ?? null : undefined };
}

async function getPoolRow(db, termId, id) {
  const { rows } = await db.query(`${POOL_SELECT} WHERE tr.id = $1 AND tr.term_id = $2`, [id, termId]);
  if (!rows[0]) throw notFound("Room not found in this term's pool");
  return rows[0];
}

async function countPlacedInRoom(db, termId, roomId) {
  const { rows: [{ n }] } = await db.query(
    `SELECT count(*)::int AS n FROM planner_sessions s JOIN planner_versions v ON v.id = s.version_id
      WHERE v.term_id = $1 AND s.room_id = $2 AND s.weekday IS NOT NULL`,
    [termId, roomId]
  );
  return n;
}

/**
 * Changes is_lab. Flipping it while any placed session of the term uses the room is refused: whether a placed lab
 * shares the room (occupancy kind lab_room) depends on is_lab and is not re-evaluated for placed sessions.
 * Takes the term's version locks first so a placement cannot slip in between the check and the update.
 */
export async function updatePoolRoom(termId, id, body) {
  const b = parse(patchSchema, body);
  return withTransaction(async (db) => {
    await lockTermVersions(db, termId);
    const row = await getPoolRow(db, termId, id);
    if (b.is_lab !== row.is_lab) {
      const n = await countPlacedInRoom(db, termId, row.room_id);
      if (n > 0) {
        throw lockedByPlacements(
          "Sessions are placed in this room, so it cannot be switched between lab and classroom. Move them out first.",
          { fields: ["is_lab"], placed: n }
        );
      }
    }
    await db.query("UPDATE planner_term_rooms SET is_lab = $2 WHERE id = $1", [id, b.is_lab]);
    return getPoolRow(db, termId, id);
  });
}

export async function removePoolRoom(termId, id) {
  await withTransaction(async (db) => {
    await lockTermVersions(db, termId);
    const row = await getPoolRow(db, termId, id);
    const n = await countPlacedInRoom(db, termId, row.room_id);
    if (n > 0) throw inUse("Sessions are placed in this room. Move them first.", { placed: n });
    await db.query("DELETE FROM planner_term_rooms WHERE id = $1", [id]);
  });
}
