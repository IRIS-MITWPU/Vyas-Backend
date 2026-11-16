// Hard room rules: room_type, room_capacity, and all_placed (contract 9.2).
//
// room_type also reports a placed session whose room is outside the term's room pool, or that has no room at all
// (checkPlacement's ROOM_NOT_IN_POOL is not one of the four blocking keys; this is the closest fit).
// room_capacity compares a session's own students with the room capacity (exclusive or shared room alike); a shared lab
// that is over-full because several batches overlap is reported once, under room_clash (blocking), not here.

export const room_type = {
  key: 'room_type',
  check(ctx) {
    const out = [];
    for (const x of ctx.placedSessions) {
      const who = `${ctx.sessLabel(x)} for ${ctx.divLabel(x.division)}`;
      let message = null;
      let fix_hint = null;
      if (!x.roomId) {
        message = `${who} on ${ctx.when(x)} has no room.`;
        fix_hint = 'Choose a room for it.';
      } else if (!x.room) {
        message = `${who} on ${ctx.when(x)} is in a room that is not in this term's room pool.`;
        fix_hint = "Choose a room from the term's room pool.";
      } else if (x.kind === 'lab' && !x.room.is_lab) {
        message = `${who} is a lab but is placed in ${x.room.name}, which is not a lab room (${ctx.when(x)}).`;
        fix_hint = 'Move it to a lab room.';
      } else if (x.kind !== 'lab' && x.room.is_lab) {
        message = `${who} is a theory session but is placed in the lab room ${x.room.name} (${ctx.when(x)}).`;
        fix_hint = 'Move it to a classroom.';
      }
      if (message) out.push(ctx.issue({ sessions: [x], weekday: x.day, message, fix_hint }));
    }
    return out;
  },
};

export const room_capacity = {
  key: 'room_capacity',
  check(ctx) {
    const out = [];
    for (const x of ctx.placedSessions) {
      const cap = x.room?.capacity;
      if (typeof cap !== 'number' || !(cap > 0) || !(x.students > cap)) continue; // unknown capacity is not flagged
      const group = x.isWhole ? ctx.divLabel(x.division) : `${ctx.divLabel(x.division)} batch ${x.batch?.name ?? ''}`.trim();
      out.push(ctx.issue({
        sessions: [x],
        weekday: x.day,
        message: `Room ${x.room.name} holds ${cap} but ${group} has ${x.students} students for ${x.code} on ${ctx.when(x)}.`,
        fix_hint: 'Move it to a bigger room.',
      }));
    }
    return out;
  },
};

/** One issue per division + subject (offering) listing what is not placed, not one per session. */
export const all_placed = {
  key: 'all_placed',
  check(ctx) {
    const groups = new Map();
    for (const x of ctx.sessions) {
      if (x.placed) continue;
      const key = x.offering_id ?? `${x.division?.id}|${x.code}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { list: [], total: 0 }));
      g.list.push(x);
    }
    if (!groups.size) return [];
    const totals = new Map();
    for (const x of ctx.sessions) {
      const key = x.offering_id ?? `${x.division?.id}|${x.code}`;
      if (groups.has(key)) totals.set(key, (totals.get(key) || 0) + 1);
    }
    const out = [];
    for (const [key, g] of groups) {
      const first = g.list[0];
      const total = totals.get(key);
      const perBatch = new Map();
      for (const x of g.list) {
        const name = x.isWhole ? null : x.batch?.name ?? '?';
        perBatch.set(name, (perBatch.get(name) || 0) + 1);
      }
      const detail = [...perBatch.entries()].some(([n]) => n !== null)
        ? ` (${[...perBatch.entries()].map(([n, c]) => (n === null ? `whole division x${c}` : `batch ${n} x${c}`)).join(', ')})`
        : '';
      const n = g.list.length;
      out.push(ctx.issue({
        sessions: g.list,
        division: first.division,
        idSessions: [], // stable while the admin places sessions one by one: the id is division + subject
        extra: first.offering_id ?? first.code,
        message: `${ctx.divLabel(first.division)}: ${n} of ${total} ${first.code} session${total === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} not placed${detail}.`,
        fix_hint: 'Place the missing sessions, or run the generator.',
      }));
    }
    return out;
  },
};

export const ROOM_RULES = [room_type, room_capacity, all_placed];
