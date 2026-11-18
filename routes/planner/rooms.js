import { Router } from "express";
import * as rooms from "../../services/planner/rooms.js";
import { ok } from "./respond.js";

const r = Router();

// ?term_id=<id> restricts the list to the term's building (all active rooms when the term has none)
r.get("/available-rooms", async (req, res) => ok(res, { rooms: await rooms.availableRooms(req.query.term_id ? String(req.query.term_id) : null) }));

r.get("/terms/:id/rooms", async (req, res) => ok(res, { rooms: await rooms.listPool(req.params.id) }));
// Adds one room ({room_id}) or several ({room_ids}); answers with the rows that were added.
r.post("/terms/:id/rooms", async (req, res) => {
  const { rooms: added, room } = await rooms.addPoolRooms(req.params.id, req.body);
  ok(res, room === undefined ? { rooms: added } : { rooms: added, room }, 201);
});
r.patch("/terms/:id/rooms/:rid", async (req, res) =>
  ok(res, { room: await rooms.updatePoolRoom(req.params.id, req.params.rid, req.body) }));
r.delete("/terms/:id/rooms/:rid", async (req, res) => {
  await rooms.removePoolRoom(req.params.id, req.params.rid);
  ok(res);
});

export default r;
