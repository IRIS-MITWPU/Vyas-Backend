// Time / grid helpers. Pure. Everything is derived from the snapshot's `term` object (working days, breaks,
// day bounds, grid, theory/lab minutes); nothing about the college day is hard-coded here.
//
// Minutes are "minutes since midnight" (08:30 = 510); weekday 0 = Monday.

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** 510 -> "08:30". */
export function fmt(min) {
  if (typeof min !== 'number' || !Number.isFinite(min)) return '--:--';
  const h = Math.floor(min / 60);
  const m = ((min % 60) + 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** "08:30" -> 510. */
export function parseHHMM(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

export const dayName = (d) => WEEKDAYS[d] ?? `D${d}`;

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

/** Normalised view of a term row. */
export function termShape(term) {
  const t = term || {};
  const days = Array.isArray(t.working_days) && t.working_days.length ? [...t.working_days].map(Number).sort((a, b) => a - b) : [0, 1, 2, 3, 4];
  const grid = Number.isInteger(t.grid_minutes) && t.grid_minutes > 0 ? t.grid_minutes : 15;
  const breaks = (Array.isArray(t.breaks) ? t.breaks : [])
    .map((b) => ({ start: Number(b.start_min), end: Number(b.end_min), label: b.label ?? '' }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
    .sort((a, b) => a.start - b.start);
  return {
    days,
    dayStart: Number.isFinite(t.day_start_min) ? t.day_start_min : 510,
    dayEnd: Number.isFinite(t.day_end_min) ? t.day_end_min : 1065,
    grid,
    // effective start step = lcm(15, grid): the SQL grid (15) and the term grid must both hold
    step: (15 * grid) / gcd(15, grid),
    theory: Number.isInteger(t.theory_minutes) && t.theory_minutes > 0 ? t.theory_minutes : 60,
    lab: Number.isInteger(t.lab_minutes) && t.lab_minutes > 0 ? t.lab_minutes : 120,
    breaks,
  };
}

/** Same rule as services/planner/domain/placement.js (order of the reasons included). */
export function validPlacement(shape, duration, day, start) {
  if (!shape.days.includes(day)) return { ok: false, reason: 'NOT_WORKING_DAY' };
  if (!Number.isInteger(start) || start % 15 !== 0 || (start - shape.dayStart) % shape.grid !== 0) return { ok: false, reason: 'OFF_GRID' };
  const end = start + duration;
  if (!(duration > 0) || start < shape.dayStart || end > shape.dayEnd) return { ok: false, reason: 'OUTSIDE_HOURS' };
  for (const b of shape.breaks) if (start < b.end && end > b.start) return { ok: false, reason: 'OVERLAPS_BREAK' };
  return { ok: true, end };
}

/** Work blocks between breaks inside the day: [{start,end}]. */
export function segments(shape) {
  const out = [];
  let cur = shape.dayStart;
  for (const b of shape.breaks) {
    if (b.end <= shape.dayStart || b.start >= shape.dayEnd) continue;
    if (b.start > cur) out.push({ start: cur, end: Math.min(b.start, shape.dayEnd) });
    cur = Math.max(cur, b.end);
  }
  if (cur < shape.dayEnd) out.push({ start: cur, end: shape.dayEnd });
  return out;
}

/**
 * "Standard" start times for a session of `duration` minutes: back-to-back cells of `theory_minutes` counted
 * from the start of every work block (day start, end of each break). With the default term and 60 min this is
 * 08:30 09:30 10:45 11:45 13:30 14:30 15:45 16:45; for a 120 min lab: 08:30 10:45 13:30 15:45.
 */
export function standardStarts(shape, duration) {
  const out = [];
  for (const seg of segments(shape)) {
    for (let s = seg.start; s + duration <= seg.end; s += shape.theory) {
      if (validPlacement(shape, duration, shape.days[0], s).ok) out.push(s);
    }
  }
  return out;
}

/** Every valid start on the grid for a session of `duration` minutes (relaxed fallback). */
export function allStarts(shape, duration) {
  const out = [];
  for (let s = shape.dayStart; s + duration <= shape.dayEnd; s += shape.step) {
    if (validPlacement(shape, duration, shape.days[0], s).ok) out.push(s);
  }
  return out;
}

/** Minutes of break time inside [a, b). */
export function breakMinutesBetween(shape, a, b) {
  let t = 0;
  for (const br of shape.breaks) {
    const lo = Math.max(a, br.start);
    const hi = Math.min(b, br.end);
    if (hi > lo) t += hi - lo;
  }
  return t;
}

/** Free (non-break) minutes strictly between two times. */
export function idleBetween(shape, a, b) {
  if (b <= a) return 0;
  return Math.max(0, b - a - breakMinutesBetween(shape, a, b));
}

/**
 * Does a run of back-to-back teaching continue from an interval ending at `endA` to one starting at `startB`?
 * Yes when no free time lies between them and no long break (>= longBreak minutes, i.e. lunch) separates them.
 */
export function runContinues(shape, endA, startB, longBreak = 30) {
  if (startB <= endA) return true;
  if (idleBetween(shape, endA, startB) > 0) return false;
  for (const b of shape.breaks) {
    if (b.start >= endA && b.end <= startB && b.end - b.start >= longBreak) return false;
  }
  return true;
}

/** Merges overlapping/touching intervals [{start,end}] (sorted result). */
export function unionIntervals(list) {
  const a = list.map((x) => ({ start: x.start, end: x.end })).sort((x, y) => x.start - y.start || x.end - y.end);
  const out = [];
  for (const x of a) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
    else out.push(x);
  }
  return out;
}

/**
 * Shape of one day's teaching for a set of intervals: union length (hours), longest run (hours; a run
 * continues over short breaks only), idle gap minutes (free time between first start and last end, breaks
 * excluded) and the number of idle gaps.
 */
export function dayStats(shape, intervals) {
  const u = unionIntervals(intervals);
  if (!u.length) return { hours: 0, maxRun: 0, idle: 0, gaps: 0, first: null, last: null };
  let minutes = 0;
  let run = 0;
  let maxRun = 0;
  let idle = 0;
  let gaps = 0;
  let prev = null;
  for (const x of u) {
    minutes += x.end - x.start;
    if (prev && runContinues(shape, prev.end, x.start)) run += x.end - x.start;
    else run = x.end - x.start;
    maxRun = Math.max(maxRun, run);
    if (prev) {
      const g = idleBetween(shape, prev.end, x.start);
      if (g > 0) {
        idle += g;
        gaps += 1;
      }
    }
    prev = x;
  }
  return { hours: minutes / 60, maxRun: maxRun / 60, idle, gaps, first: u[0].start, last: u[u.length - 1].end };
}

/** FNV-1a 32-bit hash -> [0, 1). Used for seeded deterministic tie-breaking (never Math.random). */
export function hash01(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 4294967296;
}

export const cmpText = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true, sensitivity: 'base' });
