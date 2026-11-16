// Soft division (student) rules: student_consecutive, student_idle_gap, division_daily_hours, day_balance (contract 9.2).
// A division's day = the UNION of the intervals of all its batches (whole-division sessions and batch sessions), the same
// view as the Phase 2 metrics, so a parallel lab of three batches counts once.
import { dayStats } from '../time.js';

const splitKey = (key) => {
  const i = key.lastIndexOf('|');
  return [key.slice(0, i), Number(key.slice(i + 1))];
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export const student_consecutive = {
  key: 'student_consecutive',
  check(ctx) {
    const n = num(ctx.params.n) ?? 3;
    const out = [];
    for (const [key, list] of ctx.divisionDays()) {
      const [did, day] = splitKey(key);
      const division = ctx.divById.get(did);
      for (const run of ctx.runsOf(ctx.intervals(list))) {
        if (run.minutes / 60 <= n + 1e-9) continue;
        out.push(ctx.issue({
          sessions: ctx.within(list, run.start, run.end),
          division,
          weekday: day,
          message: `${ctx.divLabel(division)} has ${ctx.fmtHours(run.minutes / 60)} h of teaching in a row on ${ctx.weekdayName(day)} (${ctx.fmtTime(run.start)}–${ctx.fmtTime(run.end)}); the limit is ${n} h.`,
          fix_hint: 'Move a session out of the stretch so students get a break.',
        }));
      }
    }
    return out;
  },
};

/**
 * Idle time of a division day = free time between its first and last session, breaks excluded (dayStats.idle). One issue
 * per division day whose total idle time exceeds params.max_gap_minutes.
 */
export const student_idle_gap = {
  key: 'student_idle_gap',
  check(ctx) {
    const max = num(ctx.params.max_gap_minutes) ?? 60;
    const out = [];
    for (const [key, list] of ctx.divisionDays()) {
      const [did, day] = splitKey(key);
      const division = ctx.divById.get(did);
      const gaps = ctx.gapsOf(ctx.intervals(list));
      const idle = gaps.reduce((t, g) => t + g.minutes, 0);
      if (idle <= max) continue;
      const where = gaps.map((g) => `${ctx.fmtTime(g.from)}–${ctx.fmtTime(g.to)}`).join(', ');
      out.push(ctx.issue({
        sessions: list,
        division,
        weekday: day,
        message: `${ctx.divLabel(division)} has ${ctx.fmtMinutes(idle)} of free time between its first and last session on ${ctx.weekdayName(day)} (${where}); the limit is ${ctx.fmtMinutes(max)}.`,
        fix_hint: 'Bring the sessions closer together.',
      }));
    }
    return out;
  },
};

export const division_daily_hours = {
  key: 'division_daily_hours',
  check(ctx) {
    const max = num(ctx.params.max_hours) ?? 6;
    const out = [];
    for (const [key, list] of ctx.divisionDays()) {
      const [did, day] = splitKey(key);
      const division = ctx.divById.get(did);
      const hours = dayStats(ctx.shape, ctx.intervals(list)).hours;
      if (hours <= max + 1e-9) continue;
      out.push(ctx.issue({
        sessions: list,
        division,
        weekday: day,
        message: `${ctx.divLabel(division)} has ${ctx.fmtHours(hours)} h of teaching on ${ctx.weekdayName(day)}; the limit is ${max} h per day.`,
        fix_hint: 'Move a session to a lighter day.',
      }));
    }
    return out;
  },
};

/** Busiest day minus lightest WORKING day (a working day with no teaching counts as 0 h) above params.max_spread_hours. */
export const day_balance = {
  key: 'day_balance',
  check(ctx) {
    const max = num(ctx.params.max_spread_hours) ?? 3;
    const days = ctx.shape.days;
    const dd = ctx.divisionDays();
    const out = [];
    for (const division of ctx.divisions) {
      const hours = days.map((d) => {
        const list = dd.get(`${division.id}|${d}`);
        return { day: d, list: list || [], hours: list ? dayStats(ctx.shape, ctx.intervals(list)).hours : 0 };
      });
      if (!hours.some((h) => h.list.length)) continue;
      let busiest = hours[0];
      let lightest = hours[0];
      for (const h of hours) {
        if (h.hours > busiest.hours) busiest = h;
        if (h.hours < lightest.hours) lightest = h;
      }
      const spread = busiest.hours - lightest.hours;
      if (spread <= max + 1e-9) continue;
      out.push(ctx.issue({
        sessions: busiest.list,
        idSessions: [],
        division,
        message: `${ctx.divLabel(division)} has ${ctx.fmtHours(busiest.hours)} h on ${ctx.weekdayName(busiest.day)} but only ${ctx.fmtHours(lightest.hours)} h on ${ctx.weekdayName(lightest.day)}: ${ctx.fmtHours(spread)} h apart, the limit is ${max} h.`,
        fix_hint: `Move a session from ${ctx.weekdayName(busiest.day)} to ${ctx.weekdayName(lightest.day)}.`,
      }));
    }
    return out;
  },
};

export const DIVISION_RULES = [student_consecutive, student_idle_gap, division_daily_hours, day_balance];
