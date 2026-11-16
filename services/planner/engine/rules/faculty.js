// Soft faculty rules: faculty_daily_load, faculty_weekly_load, faculty_consecutive, faculty_idle_gap (contract 9.2).
// A faculty day = every placed session the teacher has on that day (lead and assist alike). Runs and gaps use the
// semantics of engine/time.js (dayStats / runContinues / idleBetween), so the numbers equal the Phase 2 metrics.
import { dayStats } from '../time.js';

const splitKey = (key) => {
  const i = key.lastIndexOf('|');
  return [key.slice(0, i), Number(key.slice(i + 1))];
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** limit = faculty.max_per_day sessions when set, else params.default_max_hours hours per day. */
export const faculty_daily_load = {
  key: 'faculty_daily_load',
  check(ctx) {
    const defaultHours = num(ctx.params.default_max_hours) ?? 6;
    const out = [];
    for (const [key, list] of ctx.facultyDays()) {
      const [fid, day] = splitKey(key);
      const maxSessions = num(ctx.facById.get(fid)?.max_per_day);
      if (maxSessions !== null && maxSessions > 0) {
        if (list.length <= maxSessions) continue;
        out.push(ctx.issue({
          sessions: list,
          faculty: fid,
          weekday: day,
          message: `${ctx.facLabel(fid)} has ${list.length} sessions on ${ctx.weekdayName(day)}; their limit is ${maxSessions} per day.`,
          fix_hint: 'Move a session to a lighter day.',
        }));
        continue;
      }
      const hours = dayStats(ctx.shape, ctx.intervals(list)).hours;
      if (hours <= defaultHours + 1e-9) continue;
      out.push(ctx.issue({
        sessions: list,
        faculty: fid,
        weekday: day,
        message: `${ctx.facLabel(fid)} teaches ${ctx.fmtHours(hours)} h on ${ctx.weekdayName(day)}; the default limit is ${defaultHours} h per day.`,
        fix_hint: 'Move a session to a lighter day.',
      }));
    }
    return out;
  },
};

/** Weekly hours (sum of session durations / 60) above faculty.max_per_week; teachers without a limit are skipped. */
export const faculty_weekly_load = {
  key: 'faculty_weekly_load',
  check(ctx) {
    const byFaculty = new Map();
    for (const x of ctx.placedSessions) {
      for (const f of x.fac) (byFaculty.get(f) ?? byFaculty.set(f, []).get(f)).push(x);
    }
    const out = [];
    for (const [fid, list] of byFaculty) {
      const max = num(ctx.facById.get(fid)?.max_per_week);
      if (max === null || !(max > 0)) continue;
      const hours = list.reduce((t, x) => t + (x.end - x.start), 0) / 60;
      if (hours <= max + 1e-9) continue;
      out.push(ctx.issue({
        sessions: list,
        idSessions: [],
        faculty: fid,
        message: `${ctx.facLabel(fid)} teaches ${ctx.fmtHours(hours)} h a week; their limit is ${max} h.`,
        fix_hint: 'Give some sessions to another teacher.',
      }));
    }
    return out;
  },
};

export const faculty_consecutive = {
  key: 'faculty_consecutive',
  check(ctx) {
    const n = num(ctx.params.n) ?? 3;
    const out = [];
    for (const [key, list] of ctx.facultyDays()) {
      const [fid, day] = splitKey(key);
      for (const run of ctx.runsOf(ctx.intervals(list))) {
        if (run.minutes / 60 <= n + 1e-9) continue;
        out.push(ctx.issue({
          sessions: ctx.within(list, run.start, run.end),
          faculty: fid,
          weekday: day,
          message: `${ctx.facLabel(fid)} teaches ${ctx.fmtHours(run.minutes / 60)} h in a row on ${ctx.weekdayName(day)} (${ctx.fmtTime(run.start)}–${ctx.fmtTime(run.end)}); the limit is ${n} h.`,
          fix_hint: 'Move a session out of the stretch so the teacher gets a break.',
        }));
      }
    }
    return out;
  },
};

export const faculty_idle_gap = {
  key: 'faculty_idle_gap',
  check(ctx) {
    const max = num(ctx.params.max_gap_minutes) ?? 180;
    const out = [];
    for (const [key, list] of ctx.facultyDays()) {
      const [fid, day] = splitKey(key);
      if (list.length < 2) continue;
      for (const gap of ctx.gapsOf(ctx.intervals(list))) {
        if (gap.minutes <= max) continue;
        const before = list.find((x) => x.end === gap.from);
        const after = list.find((x) => x.start === gap.to);
        out.push(ctx.issue({
          sessions: [before, after].filter(Boolean),
          faculty: fid,
          weekday: day,
          extra: `${gap.from}`,
          message: `${ctx.facLabel(fid)} waits ${ctx.fmtMinutes(gap.minutes)} between sessions on ${ctx.weekdayName(day)} (${ctx.fmtTime(gap.from)}–${ctx.fmtTime(gap.to)}); the limit is ${ctx.fmtMinutes(max)}.`,
          fix_hint: 'Bring the two sessions closer together.',
        }));
      }
    }
    return out;
  },
};

export const FACULTY_RULES = [faculty_daily_load, faculty_weekly_load, faculty_consecutive, faculty_idle_gap];
