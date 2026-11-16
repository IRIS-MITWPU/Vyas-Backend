/**
 * Automatic room choice (contract 8.1.8, amended by 8.7). Pure, no I/O, never throws.
 *
 * pickRoom({subject, division, batch, poolRooms, busyRoomIds, roomLoads, currentRoomId})
 *   -> {room_id} | {room_id:null, reason}
 * poolRooms:   [{room_id, is_lab, capacity|null, name, building_name}]
 * busyRoomIds: Set (or array) of rooms.id that are exclusively busy at the slot (backward compatible input).
 * roomLoads:   Map or plain object  room_id -> {exclusiveBusy:boolean, sharedPeak:number, shared?:boolean}
 *              the load other sessions put on a room during the candidate interval: exclusiveBusy = an exclusive
 *              ('room') row overlaps, sharedPeak = peak concurrent students of the overlapping shared
 *              ('lab_room') rows (`shared:true` marks "some shared row overlaps" even when its size is 0).
 *
 * Lab sessions are *shareable* in a lab room with a positive integer capacity: they pack into the fullest room
 * that still has space (fewest rooms used). Everything else (theory, labs in rooms of unknown capacity) is
 * exclusive: a room with any shared load at the slot counts as busy for it.
 */
import { isShareable, studentsFor } from './roomShare.js';

function cmpText(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' });
}

function isCap(c) {
  return typeof c === 'number' && Number.isFinite(c);
}

function byBuildingName(a, b) {
  return cmpText(a.building_name, b.building_name) || cmpText(a.name, b.name);
}

function fitsNeed(room, need) {
  return !isCap(room.capacity) || room.capacity >= need;
}

function loadFor(roomLoads, id) {
  if (!roomLoads) return null;
  return roomLoads instanceof Map ? roomLoads.get(id) : Object.prototype.hasOwnProperty.call(roomLoads, id) ? roomLoads[id] : null;
}

export function pickRoom({ subject, division, batch, poolRooms, busyRoomIds, roomLoads, currentRoomId } = {}) {
  const pool = Array.isArray(poolRooms) ? poolRooms.filter((r) => r && r.room_id) : [];
  const busy = busyRoomIds instanceof Set ? busyRoomIds : new Set(Array.isArray(busyRoomIds) ? busyRoomIds : []);
  const isLab = !!subject && subject.kind === 'lab';
  const kindWord = isLab ? 'lab' : 'classroom';
  const need = studentsFor({ batch, division });

  const exclusiveBusy = (r) => busy.has(r.room_id) || loadFor(roomLoads, r.room_id)?.exclusiveBusy === true;
  const sharedPeak = (r) => {
    const n = loadFor(roomLoads, r.room_id)?.sharedPeak;
    return isCap(n) && n > 0 ? n : 0;
  };
  const hasShared = (r) => sharedPeak(r) > 0 || loadFor(roomLoads, r.room_id)?.shared === true;
  /** Free for one exclusive session: no exclusive row and no shared load at the slot. */
  const exclusiveFree = (r) => !exclusiveBusy(r) && !hasShared(r);
  const shareable = (r) => isLab && isShareable({ subject, poolRoom: r });
  /** Can this room host the session right now (shared fit for shareable sessions, exclusive freedom otherwise)? */
  const canHost = (r) => (shareable(r) ? !exclusiveBusy(r) && sharedPeak(r) + need <= r.capacity : exclusiveFree(r));

  // 1. Keep the room the session is already in, when it can still host it and is in the pool.
  if (currentRoomId) {
    const current = pool.find((r) => r.room_id === currentRoomId);
    if (current && canHost(current)) return { room_id: currentRoomId };
  }

  // 2. Theory: the division's home room.
  if (!isLab && division && division.home_room_id) {
    const home = pool.find((r) => r.room_id === division.home_room_id);
    if (home && exclusiveFree(home) && fitsNeed(home, need)) return { room_id: home.room_id };
  }

  // 3. A room of the right kind.
  const ofKind = pool.filter((r) => !!r.is_lab === isLab);
  if (ofKind.length === 0) {
    return {
      room_id: null,
      reason: isLab
        ? "No lab room is in this term's room pool. Add one on the Rooms tab."
        : "No classroom is in this term's room pool. Add one on the Rooms tab.",
    };
  }
  const allInUse = () => {
    const n = ofKind.length;
    return { room_id: null, reason: `All ${n} ${kindWord}${n === 1 ? ' is' : 's are'} already in use at that time.` };
  };

  if (!isLab) {
    // Theory: smallest free classroom that fits (known capacity first, unknown capacity last).
    const free = ofKind.filter(exclusiveFree);
    if (free.length === 0) return allInUse();
    const known = free
      .filter((r) => isCap(r.capacity) && r.capacity >= need)
      .sort((a, b) => a.capacity - b.capacity || byBuildingName(a, b));
    if (known.length) return { room_id: known[0].room_id };
    const unknown = free.filter((r) => !isCap(r.capacity)).sort(byBuildingName);
    if (unknown.length) return { room_id: unknown[0].room_id };
    const largest = Math.max(...free.map((r) => r.capacity));
    return {
      room_id: null,
      reason: `No free ${kindWord} is big enough for ${need} students (the largest free ${kindWord} seats ${largest}).`,
    };
  }

  // Lab: pack into the fullest lab that still has space; unknown-capacity labs only as a last resort (exclusive).
  const open = ofKind.filter((r) => !exclusiveBusy(r));
  if (open.length === 0) return allInUse();
  const fitting = open
    .filter((r) => shareable(r) && sharedPeak(r) + need <= r.capacity)
    .sort((a, b) => sharedPeak(b) - sharedPeak(a) || a.capacity - b.capacity || byBuildingName(a, b));
  if (fitting.length) return { room_id: fitting[0].room_id };
  const unknown = open.filter((r) => !shareable(r) && !isCap(r.capacity) && !hasShared(r)).sort(byBuildingName);
  if (unknown.length) return { room_id: unknown[0].room_id };

  const known = open.filter((r) => isCap(r.capacity));
  if (known.length === 0) return allInUse();
  if (known.some((r) => r.capacity >= need)) {
    return { room_id: null, reason: `No ${kindWord} has space for ${need} more students at that time.` };
  }
  const largest = Math.max(...known.map((r) => r.capacity));
  return {
    room_id: null,
    reason: `No free ${kindWord} is big enough for ${need} students (the largest free ${kindWord} seats ${largest}).`,
  };
}
