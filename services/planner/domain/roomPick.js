/**
 * Automatic room choice (contract 8.1.8, amended by 8.7). Pure, no I/O, never throws.
 *
 * pickRoom({subject, division, batch, poolRooms, busyRoomIds, roomLoads, currentRoomId, reservedRoomIds})
 *   -> {room_id} | {room_id:null, reason}
 * poolRooms:   [{room_id, is_lab, capacity|null, name, building_name}]
 * busyRoomIds: Set (or array) of rooms.id that are exclusively busy at the slot (backward compatible input).
 * roomLoads:   Map or plain object  room_id -> {exclusiveBusy:boolean, sharedPeak:number, shared?:boolean}
 *              the load other sessions put on a room during the candidate interval: exclusiveBusy = an exclusive
 *              ('room') row overlaps, sharedPeak = peak concurrent students of the overlapping shared
 *              ('lab_room') rows (`shared:true` marks "some shared row overlaps" even when its size is 0).
 *
 * Theory of a division WITH home classrooms (contract 10.3) only ever uses those rooms (never another room); a division
 * without any takes the smallest free classroom, preferring rooms that are no division's home room (`reservedRoomIds`,
 * a Set) so it cannot take the only free home room of a restricted division.
 *
 * Lab sessions are *shareable* in a lab room with a positive integer capacity: they pack into the fullest room
 * that still has space (fewest rooms used). Everything else (theory, labs in rooms of unknown capacity) is
 * exclusive: a room with any shared load at the slot counts as busy for it.
 */
import { isShareable, studentsFor } from './roomShare.js';
import { homeRoomIds } from './homeRooms.js';

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

export function pickRoom({ subject, division, batch, poolRooms, busyRoomIds, roomLoads, currentRoomId, reservedRoomIds } = {}) {
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

  const homeIds = !isLab ? homeRoomIds(division) : [];

  // 1. Keep the room the session is already in, when it can still host it and is in the pool (and is a home room, if restricted).
  if (currentRoomId && (homeIds.length === 0 || homeIds.includes(currentRoomId))) {
    const current = pool.find((r) => r.room_id === currentRoomId);
    if (current && canHost(current)) return { room_id: currentRoomId };
  }

  // 2. Theory of a division with home classrooms: exactly those rooms, in the order the admin listed them.
  if (homeIds.length) {
    const label = division.name ? `Division ${division.name}` : 'This division';
    const homes = homeIds.map((id) => pool.find((r) => r.room_id === id && !r.is_lab)).filter(Boolean);
    if (homes.length === 0) {
      return { room_id: null, reason: `${label} has home classrooms, but none of them is a classroom in this term's room pool. Add them on the Rooms tab.` };
    }
    const names = homes.map((r) => r.name).join(' and ');
    const free = homes.filter(exclusiveFree);
    if (free.length === 0) {
      return { room_id: null, reason: `${label}'s classroom${homes.length === 1 ? ' is' : 's (' + names + ') are'} already in use at that time.` };
    }
    const fit = free.find((r) => fitsNeed(r, need));
    if (fit) return { room_id: fit.room_id };
    const largest = Math.max(...free.map((r) => (isCap(r.capacity) ? r.capacity : 0)));
    return { room_id: null, reason: `${label}'s classroom${homes.length === 1 ? '' : 's'} (${names}) seat${homes.length === 1 ? 's' : ''} ${largest} but ${need} students need a room.` };
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
    // a classroom that is some division's home room is the last choice (it may be that division's only free room)
    const reserved = (r) => (reservedRoomIds && reservedRoomIds.has(r.room_id) ? 1 : 0);
    const known = free
      .filter((r) => isCap(r.capacity) && r.capacity >= need)
      .sort((a, b) => reserved(a) - reserved(b) || a.capacity - b.capacity || byBuildingName(a, b));
    if (known.length) return { room_id: known[0].room_id };
    const unknown = free.filter((r) => !isCap(r.capacity)).sort((a, b) => reserved(a) - reserved(b) || byBuildingName(a, b));
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
