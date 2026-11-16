// Blocking placement rules: working_hours, break_overlap, grid, duration (contract 9.2, same conditions as
// domain/placement.js checkPlacement). Each condition is evaluated independently, so a session that breaks two of them
// shows up under both keys (checkPlacement alone reports only the first failing reason).
import { overlapsBreak } from '../../domain/placement.js';
import { fmtRange } from '../../domain/explain.js';

const SQL_GRID = 15;
const mod = (a, m) => ((a % m) + m) % m;

export const working_hours = {
  key: 'working_hours',
  check(ctx) {
    const { days, dayStart, dayEnd } = ctx.shape;
    const out = [];
    for (const x of ctx.placedSessions) {
      if (!days.includes(x.day)) {
        out.push(ctx.issue({
          sessions: [x],
          weekday: x.day,
          message: `${ctx.sessLabel(x)} for ${ctx.divLabel(x.division)} is placed on ${ctx.weekdayName(x.day)}, which is not a working day for this term.`,
          fix_hint: 'Move it to a working day.',
        }));
      } else if (x.start < dayStart || x.end > dayEnd) {
        out.push(ctx.issue({
          sessions: [x],
          weekday: x.day,
          message: `${ctx.sessLabel(x)} for ${ctx.divLabel(x.division)} on ${ctx.when(x)} is outside the college day (${fmtRange(dayStart, dayEnd)}).`,
          fix_hint: `Move it inside ${fmtRange(dayStart, dayEnd)}.`,
        }));
      }
    }
    return out;
  },
};

export const break_overlap = {
  key: 'break_overlap',
  check(ctx) {
    const out = [];
    for (const x of ctx.placedSessions) {
      const hit = overlapsBreak(ctx.term, x.start, x.end);
      if (!hit) continue;
      const name = hit.label && String(hit.label).trim() ? `the ${String(hit.label).trim()}` : 'a break';
      out.push(ctx.issue({
        sessions: [x],
        weekday: x.day,
        message: `${ctx.sessLabel(x)} for ${ctx.divLabel(x.division)} on ${ctx.when(x)} overlaps ${name} (${fmtRange(hit.start_min, hit.end_min)}).`,
        fix_hint: 'Move it so it does not overlap a break.',
      }));
    }
    return out;
  },
};

export const grid = {
  key: 'grid',
  check(ctx) {
    const { grid: g, dayStart } = ctx.shape;
    const out = [];
    for (const x of ctx.placedSessions) {
      let why = null;
      if (!Number.isInteger(x.start) || mod(x.start, SQL_GRID) !== 0) why = `is not on the ${SQL_GRID}-minute grid; sessions must start on a quarter hour`;
      else if (mod(x.start - dayStart, g) !== 0) why = `is not on this term's ${g}-minute grid; sessions start every ${g} minutes from ${ctx.fmtTime(dayStart)}`;
      if (!why) continue;
      out.push(ctx.issue({
        sessions: [x],
        weekday: x.day,
        message: `${ctx.sessLabel(x)} for ${ctx.divLabel(x.division)} starts at ${ctx.fmtTime(x.start)} on ${ctx.weekdayName(x.day)}, which ${why}.`,
        fix_hint: 'Move it to a start time on the grid.',
      }));
    }
    return out;
  },
};

export const duration = {
  key: 'duration',
  check(ctx) {
    const out = [];
    for (const x of ctx.placedSessions) {
      if (typeof x.duration !== 'number' || x.end - x.start === x.duration) continue;
      out.push(ctx.issue({
        sessions: [x],
        weekday: x.day,
        message: `${ctx.sessLabel(x)} for ${ctx.divLabel(x.division)} is placed for ${ctx.fmtMinutes(x.end - x.start)} on ${ctx.when(x)}, but this subject lasts ${ctx.fmtMinutes(x.duration)}.`,
        fix_hint: 'Place it again so it gets the subject duration.',
      }));
    }
    return out;
  },
};

export const PLACEMENT_RULES = [working_hours, break_overlap, grid, duration];
