// Hard lab rules: lab_per_day and lab_weekly (contract 9.2).
import { effectiveWeeklyCount } from '../../domain/sessionSync.js';

/**
 * lab_per_day (params.max, default 1): lab sessions per batch per day. A whole-division lab session counts for every
 * batch of its division (8.1.3 batch resources); when whole-division lab sessions alone exceed the limit, that is
 * reported once for the division instead of once per batch.
 */
export const lab_per_day = {
  key: 'lab_per_day',
  check(ctx) {
    const max = Number.isInteger(ctx.params.max) ? ctx.params.max : 1;
    const out = [];
    for (const list of ctx.divisionDays().values()) {
      const labs = list.filter((x) => x.kind === 'lab');
      if (labs.length <= max) continue;
      const day = labs[0].day;
      const division = labs[0].division;
      const whole = labs.filter((x) => x.isWhole);
      const text = (xs) => xs.map((x) => `${x.code} ${ctx.fmtTime(x.start)}–${ctx.fmtTime(x.end)}`).join(', ');
      if (whole.length > max) {
        out.push(ctx.issue({
          sessions: whole,
          weekday: day,
          message: `${ctx.divLabel(division)} has ${whole.length} whole-division lab sessions on ${ctx.weekdayName(day)} (${text(whole)}); the limit is ${max} per day.`,
          fix_hint: 'Move one of the labs to another day.',
        }));
        continue;
      }
      const byBatch = new Map();
      for (const x of labs) if (!x.isWhole) (byBatch.get(x.batch_id) ?? byBatch.set(x.batch_id, []).get(x.batch_id)).push(x);
      const realBatches = (division?.batches || []).filter((b) => !b.is_whole);
      const batchIds = realBatches.length ? realBatches.map((b) => b.id) : [];
      for (const bid of batchIds) {
        const mine = [...(byBatch.get(bid) || []), ...whole];
        if (mine.length <= max || !byBatch.has(bid)) continue;
        const bname = realBatches.find((b) => b.id === bid)?.name ?? '';
        out.push(ctx.issue({
          sessions: mine,
          weekday: day,
          message: `Batch ${bname} of ${ctx.divLabel(division)} has ${mine.length} lab sessions on ${ctx.weekdayName(day)} (${text(mine)}); the limit is ${max} per day.`,
          fix_hint: 'Move one of the labs to another day.',
        }));
      }
    }
    return out;
  },
};

/**
 * lab_weekly (contract 9.2): a lab subject meets each batch `effective_weekly_count` times a week. This rule flags only
 * when the placed lab sessions of one batch for one offering EXCEED that count (surplus sessions); fewer placed sessions
 * than the target are all_placed's business.
 *
 * DATA NOTE: a lab subject with weekly_count > 1 and allow_second_lab = false is a DATA inconsistency (it asks for several
 * labs a week but forbids a second one). The generator then simply places weekly_count sessions (it never flags its own
 * output here); the readiness check should warn about that combination (not implemented in this rule).
 */
export const lab_weekly = {
  key: 'lab_weekly',
  check(ctx) {
    const groups = new Map();
    for (const x of ctx.placedSessions) {
      if (x.kind !== 'lab') continue;
      const key = `${x.offering_id}|${x.batch_id}`;
      (groups.get(key) ?? groups.set(key, []).get(key)).push(x);
    }
    const out = [];
    for (const list of groups.values()) {
      const x0 = list[0];
      const target = Number.isFinite(x0.offering?.effective_weekly_count)
        ? x0.offering.effective_weekly_count
        : effectiveWeeklyCount(x0.offering, x0.subject);
      if (!(target > 0) || list.length <= target) continue;
      const who = x0.isWhole ? ctx.divLabel(x0.division) : `batch ${x0.batch?.name ?? ''} of ${ctx.divLabel(x0.division)}`;
      out.push(ctx.issue({
        sessions: list,
        message: `${x0.code} has ${list.length} lab sessions placed for ${who}, but it meets ${target} time${target === 1 ? '' : 's'} a week.`,
        fix_hint: 'Unplace the extra lab session.',
      }));
    }
    return out;
  },
};

export const LAB_RULES = [lab_per_day, lab_weekly];
