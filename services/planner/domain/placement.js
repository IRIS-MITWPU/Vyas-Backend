/**
 * Placement rule (contract 8.1.2). Pure, no I/O, never throws.
 *
 * checkPlacement({term, subject, weekday, start_min, room_id?, poolRoomIds?})
 *   -> {ok:true, end_min} | {ok:false, reason, message}
 * reason: NOT_WORKING_DAY | OFF_GRID | OUTSIDE_HOURS | OVERLAPS_BREAK | ROOM_NOT_IN_POOL
 * (checked in that order).
 */
import { DEFAULT_TERM_SETTINGS, workingDays } from './termDefaults.js';
import { fmtTime, fmtRange, weekdayName } from './explain.js';

/** The hard-wired SQL grid (planner_sessions.start_min % 15 = 0). */
const SQL_GRID = 15;

function num(v, fallback) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

function mod(a, m) {
  return ((a % m) + m) % m;
}

function gridMinutes(term) {
  const g = num(term && term.grid_minutes, DEFAULT_TERM_SETTINGS.grid_minutes);
  return Number.isInteger(g) && g > 0 ? g : DEFAULT_TERM_SETTINGS.grid_minutes;
}

function dayBounds(term) {
  const t = term || {};
  return {
    start: num(t.day_start_min, DEFAULT_TERM_SETTINGS.day_start_min),
    end: num(t.day_end_min, DEFAULT_TERM_SETTINGS.day_end_min),
  };
}

/** Effective placement step in minutes = lcm(15, grid_minutes). */
export function gridStep(term) {
  const g = gridMinutes(term);
  return (SQL_GRID * g) / gcd(SQL_GRID, g);
}

/** Usable breaks of a term, sorted by start. Bad entries are skipped. */
function validBreaks(term) {
  const raw = term && Array.isArray(term.breaks) ? term.breaks : DEFAULT_TERM_SETTINGS.breaks;
  const out = [];
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue;
    const s = num(b.start_min, NaN);
    const e = num(b.end_min, NaN);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    out.push({ b, s, e });
  }
  out.sort((x, y) => x.s - y.s);
  return out;
}

/** The first (earliest) break overlapping [start, end) (half-open), or null. */
export function overlapsBreak(term, start, end) {
  const s = num(start, NaN);
  const e = num(end, NaN);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  for (const x of validBreaks(term)) {
    if (s < x.e && e > x.s) return x.b;
  }
  return null;
}

function breakName(b) {
  const label = b && typeof b.label === 'string' ? b.label.trim() : '';
  return label ? `the ${label}` : 'the break';
}

function fail(reason, message) {
  return { ok: false, reason, message };
}

export function checkPlacement(input) {
  const { term, subject, weekday, start_min, room_id, poolRoomIds } = input || {};

  // 1. Working day
  const days = workingDays(term);
  if (!Number.isInteger(weekday) || !days.includes(weekday)) {
    return fail('NOT_WORKING_DAY', `${weekdayName(weekday)} is not a working day for this term.`);
  }
  const dayName = weekdayName(weekday);

  // 2. Grid
  const { start: dayStart, end: dayEnd } = dayBounds(term);
  if (typeof start_min !== 'number' || !Number.isInteger(start_min)) {
    return fail('OFF_GRID', 'Please choose a valid start time.');
  }
  const g = gridMinutes(term);
  if (mod(start_min, SQL_GRID) !== 0) {
    return fail('OFF_GRID', `${fmtTime(start_min)} is not on the ${SQL_GRID}-minute grid; sessions must start on a quarter hour.`);
  }
  if (mod(start_min - dayStart, g) !== 0) {
    return fail('OFF_GRID', `${fmtTime(start_min)} is not on this term's ${g}-minute grid; sessions start every ${g} minutes from ${fmtTime(dayStart)}.`);
  }

  // 3. Working hours
  const duration = num(subject && subject.duration_min, NaN);
  if (!Number.isFinite(duration) || duration <= 0) {
    return fail('OUTSIDE_HOURS', 'This subject has no valid session duration, so it cannot be placed.');
  }
  if (start_min < dayStart) {
    return fail('OUTSIDE_HOURS', `${dayName} ${fmtTime(start_min)} is before the day starts at ${fmtTime(dayStart)}.`);
  }
  const end_min = start_min + duration;
  if (end_min > dayEnd) {
    return fail('OUTSIDE_HOURS', `${dayName} ${fmtRange(start_min, end_min)} runs past the end of the day at ${fmtTime(dayEnd)}.`);
  }

  // 4. Breaks
  const hit = overlapsBreak(term, start_min, end_min);
  if (hit) {
    return fail(
      'OVERLAPS_BREAK',
      `${dayName} ${fmtRange(start_min, end_min)} overlaps ${breakName(hit)} (${fmtRange(hit.start_min, hit.end_min)}).`,
    );
  }

  // 5. Room pool (only when both are given)
  if (room_id && poolRoomIds) {
    const pool = poolRoomIds instanceof Set ? poolRoomIds : new Set(Array.isArray(poolRoomIds) ? poolRoomIds : []);
    if (!pool.has(room_id)) {
      return fail('ROOM_NOT_IN_POOL', "That room is not in this term's room pool.");
    }
  }

  return { ok: true, end_min };
}
