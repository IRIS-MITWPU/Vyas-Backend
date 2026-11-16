/**
 * Lab-room sharing by capacity (contract 8.7). Pure, no I/O, never throws.
 *
 * A session is *shareable* when its subject is a lab and it sits in a pool room that is a lab with a known
 * (positive integer) capacity. Shareable sessions get a 'lab_room' occupancy row and may overlap other
 * shareable sessions in the same room as long as the concurrent student load never exceeds the capacity.
 */

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function students(v) {
  return isNum(v) && v > 0 ? v : 0;
}

/** subject.kind === 'lab' AND poolRoom.is_lab === true AND poolRoom.capacity is a positive integer. */
export function isShareable({ subject, poolRoom } = {}) {
  return (
    !!subject && subject.kind === 'lab' &&
    !!poolRoom && poolRoom.is_lab === true &&
    Number.isInteger(poolRoom.capacity) && poolRoom.capacity > 0
  );
}

/** Students a session brings: the batch size, or the whole division for the whole batch. */
export function studentsFor({ batch, division } = {}) {
  const raw = batch && !batch.is_whole ? batch.student_count : division && division.student_count;
  return students(raw);
}

/**
 * Maximum concurrent student load over every instant of [window.start_min, window.end_min).
 * `intervals` = [{start_min, end_min, students}], half-open. Intervals outside the window are ignored,
 * the others are clipped to it. At an equal timestamp an end is processed before a start (back-to-back
 * sessions do not add up). An empty/invalid window gives 0.
 */
export function peakLoad(intervals, window) {
  const lo = window && window.start_min;
  const hi = window && window.end_min;
  if (!isNum(lo) || !isNum(hi) || hi <= lo) return 0;
  const events = [];
  for (const it of Array.isArray(intervals) ? intervals : []) {
    if (!it || !isNum(it.start_min) || !isNum(it.end_min)) continue;
    const s = Math.max(it.start_min, lo);
    const e = Math.min(it.end_min, hi);
    if (e <= s) continue;
    const n = students(it.students);
    events.push([s, 1, n], [e, 0, n]); // 0 = end sorts before 1 = start at the same minute
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let load = 0;
  let peak = 0;
  for (const [, isStart, n] of events) {
    load += isStart ? n : -n;
    if (load > peak) peak = load;
  }
  return peak;
}

/**
 * Does `candidate` fit into a room of `capacity` next to `existing` shared sessions?
 *   -> {ok:true, peak} | {ok:false, peak, capacity}
 * peak = highest concurrent student count during the candidate's interval, candidate included.
 */
export function fitsInRoom({ capacity, existing, candidate } = {}) {
  const cand = candidate || {};
  const validWindow = isNum(cand.start_min) && isNum(cand.end_min) && cand.end_min > cand.start_min;
  const p = validWindow ? peakLoad([...(Array.isArray(existing) ? existing : []), cand], cand) : students(cand.students);
  if (isNum(capacity) && p <= capacity) return { ok: true, peak: p };
  return { ok: false, peak: p, capacity };
}
