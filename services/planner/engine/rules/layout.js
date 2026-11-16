// Soft layout rules: subject_spread, room_change, time_of_day (contract 9.2).
import { effectiveWeeklyCount } from '../../domain/sessionSync.js';

/**
 * subject_spread (params.max_per_day, default 1): theory sessions of one subject for one division (per batch for a
 * per-batch theory offering) on the same day. Back-to-back repeats are accepted only when the weekly count is larger
 * than the number of working days (they cannot be avoided). Labs are covered by lab_per_day.
 */
export const subject_spread = {
  key: 'subject_spread',
  check(ctx) {
    const max = Number.isInteger(ctx.params.max_per_day) ? ctx.params.max_per_day : 1;
    const groups = new Map();
    for (const x of ctx.placedSessions) {
      if (x.kind === 'lab') continue;
      const key = `${x.offering_id}|${x.batch_id}|${x.day}`;
      (groups.get(key) ?? groups.set(key, []).get(key)).push(x);
    }
    const out = [];
    for (const list of groups.values()) {
      if (list.length <= max) continue;
      const x0 = list[0];
      list.sort((a, b) => a.start - b.start);
      const weekly = Number.isFinite(x0.offering?.effective_weekly_count)
        ? x0.offering.effective_weekly_count
        : effectiveWeeklyCount(x0.offering, x0.subject);
      const backToBack = list.every((x, i) => i === 0 || x.start === list[i - 1].end);
      if (weekly > ctx.shape.days.length && backToBack) continue;
      out.push(ctx.issue({
        sessions: list,
        weekday: x0.day,
        message: `${x0.code} is scheduled ${list.length} times on ${ctx.weekdayName(x0.day)} for ${ctx.divLabel(x0.division)} (${list.map((x) => ctx.fmtTime(x.start)).join(', ')}); the limit is ${max} per day.`,
        fix_hint: 'Spread the subject over different days.',
      }));
    }
    return out;
  },
};

/**
 * room_change. Looks at the whole-division THEORY sessions of a division day in time order (labs are skipped: moving to
 * a lab room is unavoidable). Two consecutive sessions in different rooms need a long enough pause between them:
 *   mode 'any_break'  : any gap of at least `min_break_minutes` (default: any gap > 0, i.e. not back to back);
 *   mode 'lunch_only' : a term break of at least max(30, min_break_minutes) minutes (the lunch) must lie between them.
 */
export const room_change = {
  key: 'room_change',
  check(ctx) {
    const mode = ctx.params.mode === 'lunch_only' ? 'lunch_only' : 'any_break';
    const minBreak = Number.isFinite(ctx.params.min_break_minutes) ? ctx.params.min_break_minutes : null;
    const out = [];
    for (const list of ctx.divisionDays().values()) {
      const seq = list.filter((x) => x.isWhole && x.kind !== 'lab' && x.roomId);
      for (let i = 1; i < seq.length; i++) {
        const a = seq[i - 1];
        const b = seq[i];
        if (a.roomId === b.roomId || b.start < a.end) continue;
        const gap = b.start - a.end;
        let enough;
        if (mode === 'lunch_only') {
          const need = Math.max(30, minBreak ?? 0);
          enough = ctx.shape.breaks.some((br) => br.start >= a.end && br.end <= b.start && br.end - br.start >= need);
        } else {
          enough = gap > 0 && gap >= (minBreak ?? 1);
        }
        if (enough) continue;
        out.push(ctx.issue({
          sessions: [a, b],
          weekday: a.day,
          message: `${ctx.divLabel(a.division)} moves from room ${a.room?.name ?? '?'} (${a.code}, ${ctx.fmtTime(a.start)}–${ctx.fmtTime(a.end)}) to room ${b.room?.name ?? '?'} (${b.code}, ${ctx.fmtTime(b.start)}–${ctx.fmtTime(b.end)}) on ${ctx.weekdayName(a.day)} ${gap > 0 ? `with only ${ctx.fmtMinutes(gap)} in between` : 'with no break in between'}.`,
          fix_hint: "Keep both sessions in the division's home room.",
        }));
      }
    }
    return out;
  },
};

/**
 * Theory sessions that start late (at/after late_start). Supervisor decision (2026-11-16): early starts before
 * core_start are normal in the admin's grids and only a mild generator preference, so they are NOT diagnosed
 * (118 of 175 soft issues on the real timetable were pure noise). core_start/core_end stay generator inputs.
 */
export const time_of_day = {
  key: 'time_of_day',
  check(ctx) {
    const { late_start: ls } = { late_start: 945, ...ctx.params };
    const out = [];
    for (const x of ctx.placedSessions) {
      if (x.kind === 'lab') continue;
      if (x.start < ls) continue;
      out.push(ctx.issue({
        sessions: [x],
        weekday: x.day,
        message: `${ctx.sessLabel(x)} for ${ctx.divLabel(x.division)} on ${ctx.weekdayName(x.day)} starts late, at ${ctx.fmtTime(x.start)} (late starts begin at ${ctx.fmtTime(ls)}).`,
        fix_hint: 'Move it earlier in the day.',
      }));
    }
    return out;
  },
};

export const LAYOUT_RULES = [subject_spread, room_change, time_of_day];
