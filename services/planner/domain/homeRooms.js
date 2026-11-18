/**
 * Home classrooms of a division (contract 10.3). Pure, no I/O.
 *
 * A division has at most two home classrooms. When it has any, its THEORY sessions may only use those rooms; a division with
 * none uses any classroom of the term's room pool. Labs are never restricted.
 */

export const MAX_HOME_ROOMS = 2;

/** The division's home room ids (0-2, de-duplicated, first room first). Accepts `home_room_ids` or the two raw columns. */
export function homeRoomIds(division) {
  if (!division) return [];
  const raw = Array.isArray(division.home_room_ids) ? division.home_room_ids : [division.home_room_id, division.home_room2_id];
  const out = [];
  for (const id of raw) if (id && !out.includes(id)) out.push(id);
  return out.slice(0, MAX_HOME_ROOMS);
}

/** Ids of every home room of every division (the fallback pick avoids them so it cannot take another division's room). */
export function allHomeRoomIds(divisions) {
  const set = new Set();
  const list = divisions instanceof Map ? [...divisions.values()] : Array.isArray(divisions) ? divisions : [];
  for (const d of list) for (const id of homeRoomIds(d)) set.add(id);
  return set;
}

/** Is a THEORY session of `division` forbidden from using `roomId`? (false for labs, unrestricted divisions and a missing room) */
export function violatesHomeRooms({ subject, division, room_id }) {
  if (!room_id || !division || (subject && subject.kind === 'lab')) return false;
  const ids = homeRoomIds(division);
  return ids.length > 0 && !ids.includes(room_id);
}
