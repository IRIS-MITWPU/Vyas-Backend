/**
 * Term defaults and derived term values. Pure, no I/O.
 *
 * `term` shape (plain JSON, snake_case, as returned by the API / DB row):
 *   {
 *     start_date?: 'YYYY-MM-DD' | Date | null,
 *     end_date?:   'YYYY-MM-DD' | Date | null,
 *     working_days?: number[],            // 0=Mon … 6=Sun
 *     day_start_min?: number, day_end_min?: number,   // minutes since midnight
 *     grid_minutes?, theory_minutes?, lab_minutes?: number,
 *     breaks?: [{start_min, end_min, label?}]
 *   }
 * Any missing field falls back to DEFAULT_TERM_SETTINGS.
 */

export const DEFAULT_BREAKS = Object.freeze([
  Object.freeze({ start_min: 630, end_min: 645, label: 'Short break 1' }),
  Object.freeze({ start_min: 765, end_min: 810, label: 'Lunch' }),
  Object.freeze({ start_min: 930, end_min: 945, label: 'Short break 2' }),
]);

export const DEFAULT_TERM_SETTINGS = Object.freeze({
  branch: 'CSE',
  working_days: Object.freeze([0, 1, 2, 3, 4]),
  day_start_min: 510,
  day_end_min: 1065,
  grid_minutes: 15,
  theory_minutes: 60,
  lab_minutes: 120,
  breaks: DEFAULT_BREAKS,
});

function num(v, fallback) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** Working days of the term (defaults to Mon-Fri). */
export function workingDays(term) {
  const wd = term && Array.isArray(term.working_days) ? term.working_days : null;
  const clean = wd ? [...new Set(wd.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : [];
  return clean.length ? clean : [...DEFAULT_TERM_SETTINGS.working_days];
}

/**
 * Teachable minutes per day = (day_end - day_start) - sum of break minutes
 * that lie inside the day. Overlapping breaks are merged so they are not
 * counted twice; breaks partly outside the day are clipped to it.
 */
export function teachableMinutesPerDay(term) {
  const t = term || {};
  const start = num(t.day_start_min, DEFAULT_TERM_SETTINGS.day_start_min);
  const end = num(t.day_end_min, DEFAULT_TERM_SETTINGS.day_end_min);
  if (end <= start) return 0;
  const breaks = Array.isArray(t.breaks) ? t.breaks : DEFAULT_TERM_SETTINGS.breaks;
  const spans = [];
  for (const b of breaks) {
    if (!b) continue;
    const s = Math.max(start, num(b.start_min, NaN));
    const e = Math.min(end, num(b.end_min, NaN));
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) spans.push([s, e]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let breakMinutes = 0;
  let curS = null;
  let curE = null;
  for (const [s, e] of spans) {
    if (curE === null || s > curE) {
      if (curE !== null) breakMinutes += curE - curS;
      curS = s;
      curE = e;
    } else if (e > curE) {
      curE = e;
    }
  }
  if (curE !== null) breakMinutes += curE - curS;
  return end - start - breakMinutes;
}

function toUtcDay(d) {
  if (d === null || d === undefined || d === '') return null;
  if (d instanceof Date) {
    return Number.isNaN(d.getTime()) ? null : Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(ms) ? null : ms;
}

/** ceil((end - start + 1) / 7) in days; null when a date is missing/invalid or end < start. */
export function termWeeks(term) {
  if (!term) return null;
  const s = toUtcDay(term.start_date);
  const e = toUtcDay(term.end_date);
  if (s === null || e === null || e < s) return null;
  const days = Math.round((e - s) / 86400000) + 1;
  return Math.ceil(days / 7);
}

/** Default session duration for a subject kind ('lab' → lab_minutes, otherwise theory_minutes). */
export function defaultDurationFor(kind, term) {
  const t = term || {};
  if (String(kind || '').toLowerCase() === 'lab') {
    return num(t.lab_minutes, DEFAULT_TERM_SETTINGS.lab_minutes);
  }
  return num(t.theory_minutes, DEFAULT_TERM_SETTINGS.theory_minutes);
}
