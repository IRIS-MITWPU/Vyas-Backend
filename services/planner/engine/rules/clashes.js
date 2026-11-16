// Blocking double-booking rules: faculty_clash, room_clash, batch_clash (contract 9.2, 8.1.3, 8.7).
import { peakLoad } from '../../domain/roomShare.js';

/** Overlapping pairs [a, b] of a start-sorted list of placed sessions (half-open intervals). */
export function overlappingPairs(list) {
  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length && list[j].start < list[i].end; j++) {
      if (list[j].end > list[i].start) pairs.push([list[i], list[j]]);
    }
  }
  return pairs;
}

export const faculty_clash = {
  key: 'faculty_clash',
  check(ctx) {
    const out = [];
    for (const [key, list] of ctx.facultyDays()) {
      if (list.length < 2) continue;
      const fid = key.slice(0, key.lastIndexOf('|'));
      for (const [a, b] of overlappingPairs(list)) {
        out.push(ctx.issue({
          sessions: [a, b],
          faculty: fid,
          weekday: a.day,
          message: `${ctx.facLabel(fid)} is teaching both ${ctx.sessLabel(a)} for ${ctx.divLabel(a.division)} (${ctx.fmtTime(a.start)}–${ctx.fmtTime(a.end)}) and ${ctx.sessLabel(b)} for ${ctx.divLabel(b.division)} (${ctx.fmtTime(b.start)}–${ctx.fmtTime(b.end)}) on ${ctx.weekdayName(a.day)}.`,
          fix_hint: 'Move one of the two sessions to another time, or give it another teacher.',
        }));
      }
    }
    return out;
  },
};

/**
 * Students: a whole-division session brings every batch of the division, a batch session only its own batch
 * (8.1.3). So two sessions of one division clash when either is whole-division or both are the same batch;
 * two different batches do not clash.
 */
export const batch_clash = {
  key: 'batch_clash',
  check(ctx) {
    const out = [];
    for (const list of ctx.divisionDays().values()) {
      if (list.length < 2) continue;
      for (const [a, b] of overlappingPairs(list)) {
        if (!(a.isWhole || b.isWhole || a.batch_id === b.batch_id)) continue;
        const who = (x) => (x.isWhole ? `all of ${ctx.divLabel(x.division)}` : `${ctx.divLabel(x.division)} batch ${x.batch?.name ?? ''}`.trim());
        out.push(ctx.issue({
          sessions: [a, b],
          weekday: a.day,
          message: `${who(a)} has ${ctx.sessLabel(a)} (${ctx.fmtTime(a.start)}–${ctx.fmtTime(a.end)}) and ${ctx.sessLabel(b)} (${ctx.fmtTime(b.start)}–${ctx.fmtTime(b.end)}) at the same time on ${ctx.weekdayName(a.day)}.`,
          fix_hint: 'Move one of the two sessions to another time.',
        }));
      }
    }
    return out;
  },
};

/**
 * Rooms: any overlap of two exclusive sessions (or exclusive + shared) is a clash. Shared lab sessions (lab subject in a
 * lab room with a known capacity, 8.7) may overlap as long as the concurrent student load stays within the capacity;
 * an over-full window is reported here (once per window, not again under room_capacity).
 */
export const room_clash = {
  key: 'room_clash',
  check(ctx) {
    const out = [];
    for (const list of ctx.roomDays().values()) {
      if (list.length < 2) continue;
      for (const [a, b] of overlappingPairs(list)) {
        if (a.shared && b.shared) continue;
        out.push(ctx.issue({
          sessions: [a, b],
          weekday: a.day,
          message: `Room ${a.room?.name ?? 'a room'} is used by ${ctx.sessLabel(a)} for ${ctx.divLabel(a.division)} (${ctx.fmtTime(a.start)}–${ctx.fmtTime(a.end)}) and by ${ctx.sessLabel(b)} for ${ctx.divLabel(b.division)} (${ctx.fmtTime(b.start)}–${ctx.fmtTime(b.end)}) on ${ctx.weekdayName(a.day)}.`,
          fix_hint: 'Give one of the sessions another room or time.',
        }));
      }
      const shared = list.filter((x) => x.shared);
      if (shared.length < 2) continue;
      const cap = shared[0].room.capacity;
      const cuts = [...new Set(shared.flatMap((x) => [x.start, x.end]))].sort((p, q) => p - q);
      const windows = [];
      let win = null;
      for (let i = 0; i + 1 < cuts.length; i++) {
        const live = ctx.within(shared, cuts[i], cuts[i + 1]);
        const load = live.reduce((t, x) => t + x.students, 0);
        if (load > cap) {
          if (win && win.to === cuts[i]) win.to = cuts[i + 1];
          else windows.push((win = { from: cuts[i], to: cuts[i + 1] }));
        } else {
          win = null;
        }
      }
      for (const w of windows) {
        const inWin = ctx.within(shared, w.from, w.to);
        const peak = peakLoad(inWin.map((x) => ({ start_min: x.start, end_min: x.end, students: x.students })), { start_min: w.from, end_min: w.to });
        const day = inWin[0].day;
        const names = inWin.map((x) => `${ctx.sessLabel(x)} for ${ctx.divLabel(x.division)} (${x.students} students)`).join(' and ');
        out.push(ctx.issue({
          sessions: inWin,
          weekday: day,
          extra: `${w.from}`,
          message: `Room ${shared[0].room.name} (capacity ${cap}) would hold ${peak} students on ${ctx.weekdayName(day)} ${ctx.fmtTime(w.from)}–${ctx.fmtTime(w.to)}: ${names}.`,
          fix_hint: 'Move a batch to another lab room or time.',
        }));
      }
    }
    return out;
  },
};

export const CLASH_RULES = [faculty_clash, room_clash, batch_clash];
