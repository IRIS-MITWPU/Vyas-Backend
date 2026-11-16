/**
 * Occupancy rows for a placed session (contract 8.1.3). Pure, no I/O, never throws.
 */

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Batch resource ids a session on `batch_id` occupies.
 * Whole batch -> the whole id plus every non-whole batch id of the division.
 * Non-whole batch -> only its own id. Unknown batch -> just [batch_id].
 */
export function batchResourceIds(division, batch_id) {
  if (batch_id === null || batch_id === undefined || batch_id === '') return [];
  const batches = division && Array.isArray(division.batches) ? division.batches.filter(Boolean) : [];
  const self = batches.find((b) => b.id === batch_id);
  if (!self || !self.is_whole) return [batch_id];
  const ids = [self.id];
  for (const b of batches) {
    if (!b.is_whole && b.id !== null && b.id !== undefined && !ids.includes(b.id)) ids.push(b.id);
  }
  return ids;
}

/**
 * [{kind:'faculty'|'room'|'lab_room'|'batch', resource_id, weekday, start_min, end_min}], de-duplicated.
 * The room row is 'lab_room' when `session.shared_room === true` (contract 8.7), else 'room'.
 * An unplaced session gives [].
 */
export function occupancyRows({ session, division } = {}) {
  const s = session || {};
  if (
    !isNum(s.weekday) || !isNum(s.start_min) || !isNum(s.end_min) ||
    s.room_id === null || s.room_id === undefined || s.room_id === ''
  ) {
    return [];
  }
  const rows = [];
  const seen = new Set();
  const add = (kind, resource_id) => {
    if (resource_id === null || resource_id === undefined || resource_id === '') return;
    const key = `${kind}|${resource_id}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ kind, resource_id, weekday: s.weekday, start_min: s.start_min, end_min: s.end_min });
  };
  for (const f of Array.isArray(s.faculty_ids) ? s.faculty_ids : []) add('faculty', f);
  // shared lab rooms (contract 8.7) use their own kind: several sessions may overlap there, up to the capacity
  add(s.shared_room === true ? 'lab_room' : 'room', s.room_id);
  for (const b of batchResourceIds(division, s.batch_id)) add('batch', b);
  return rows;
}
