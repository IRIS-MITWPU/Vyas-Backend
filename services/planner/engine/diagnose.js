// Why is a session unplaced? (port of diagnose() of tests/planner/real/lib/engine.mjs, with plain-English texts.) Pure.
//
// diagnose(model, sid, reason?, config?, {ignoreSlot?:{day,start}}) -> {code, text, slots:{total,free,faculty,batch,room}, teachers, engine, day_names}
// code: FACULTY_BUSY | DIVISION_BUSY | NO_ROOM | POLICY_RULES | IDLE_GAP | LOCKED. (SERVER_REFUSED / TRY_LIMIT are set by the caller
// through `reason.code`; the in-memory engine itself never produces them.)
import { allStarts, dayName } from './time.js';
import { theoryCandidates, labBlockCandidates } from './rank.js';
import { defaultEngineConfig } from './config.js';

/** Is there any slot left that satisfies the hard rules (the relaxed candidate lists)? */
export function hasPolicyCandidate(model, sid, config) {
  const i = model.info.get(sid);
  if (i.kind !== 'lab') return theoryCandidates(model, sid, { strict: false, config }).length > 0;
  const block = { key: sid, sessions: [{ id: sid }] };
  return labBlockCandidates(model, block, { strict: false, config }).length > 0;
}

/** "Prof. X (AB)" style label of a faculty id. */
export function facultyLabel(model, f) {
  const row = model.faculty.get(f);
  if (!row) return String(f);
  return row.full_name ? `${row.full_name} (${row.short_code})` : String(row.short_code);
}

const join = (names) => (names.length <= 1 ? names[0] ?? 'the teacher' : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** Counts why each valid slot of the week is not usable: {total, free, faculty, batch, room} (first failing check wins). */
export function slotCounts(model, sid, ignoreSlot = null) {
  const i = model.info.get(sid);
  const starts = allStarts(model.shape, i.duration);
  const c = { total: 0, free: 0, faculty: 0, batch: 0, room: 0 };
  for (const day of model.shape.days) {
    for (const s of starts) {
      if (ignoreSlot && ignoreSlot.day === day && ignoreSlot.start === s) continue; // the session's own current slot
      c.total += 1;
      const ev = model.evaluate(sid, day, s);
      if (ev.ok) c.free += 1;
      else if (ev.why in c) c[ev.why] += 1;
    }
  }
  return c;
}

function blockedText(model, i, c, teachers) {
  const isLab = i.kind === 'lab';
  const who = join(teachers);
  const verb = teachers.length > 1 ? 'are' : 'is';
  const division = i.whole || !i.batch_name ? `${i.division_name} (Sem ${i.semester})` : `${i.division_name} ${i.batch_name} (Sem ${i.semester})`;
  const clauses = [];
  if (c.faculty) clauses.push({ kind: 'faculty', n: c.faculty });
  if (c.batch) clauses.push({ kind: 'batch', n: c.batch });
  if (c.room) clauses.push({ kind: 'room', n: c.room });
  clauses.sort((a, b) => b.n - a.n);
  const parts = clauses.map((cl, k) => {
    const last = clauses.length > 1 && k === clauses.length - 1;
    // no slot is free, so the counts add up to the total: the last clause is "the other n"
    const count = last ? `the other ${cl.n}` : k === 0 ? (cl.n === c.total ? (c.total === 1 ? 'the only slot' : `all ${c.total} slots`) : `${cl.n} of ${c.total} slots`) : `${cl.n} more`;
    if (cl.kind === 'faculty') return `${who} ${verb} busy in ${count}`;
    if (cl.kind === 'batch') return `${division} already has class in ${count}`;
    return `no ${isLab ? 'lab room' : 'classroom'} is free in ${count}`;
  });
  return `${parts.join('; ')}.`;
}

export function diagnose(model, sid, reason = null, config = undefined, { ignoreSlot = null } = {}) {
  const i = model.info.get(sid);
  const c = slotCounts(model, sid, ignoreSlot);
  const teachers = i.faculty_ids.map((f) => facultyLabel(model, f));
  const shortCodes = i.faculty_ids.map((f) => model.faculty.get(f)?.short_code ?? f);
  let code;
  let text;
  if (i.locked) {
    code = 'LOCKED';
    text = 'The session is locked, so the generator left it alone.';
  } else if (c.total === 0) {
    // not one start time of the week fits the session (e.g. it is longer than every teaching window): no room/teacher/division is to blame
    code = 'NO_ROOM';
    text = `No time slot of the week is long enough for this ${i.duration}-minute session (it does not fit between the breaks and the end of the day), so it cannot be placed. Check the subject's duration and the term's teaching hours.`;
  } else if (c.free > 0) {
    const policy = hasPolicyCandidate(model, sid, config);
    if (!policy) {
      const cfg = config || defaultEngineConfig();
      const idleHard = cfg.hard.divisionIdleGapMinutes !== null;
      const withoutIdle = idleHard && hasPolicyCandidate(model, sid, { ...cfg, hard: { ...cfg.hard, divisionIdleGapMinutes: null} });
      if (withoutIdle) {
        // the "no free time between lectures" rule is the only thing standing in the way
        code = 'IDLE_GAP';
        text = `${c.free} slot${c.free === 1 ? ' is' : 's are'} free, but each would leave free time between ${i.division_name}'s lectures on that day (the "no idle time" rule). Move another session next to this one's slot, or allow some idle time on the Rules tab.`;
      } else {
        code = 'POLICY_RULES';
        text = `${c.free} slot${c.free === 1 ? ' is' : 's are'} free, but each would break a hard rule (the same subject twice a day, a second lab for the batch that day, a teacher's daily limit, or a rule set to hard).`;
      }
    } else if (reason && (reason.code === 'SERVER_REFUSED' || reason.code === 'TRY_LIMIT')) {
      code = reason.code;
      text = `${c.free} slot${c.free === 1 ? ' looks' : 's look'} free, but the server refused every candidate tried${reason.last?.message ? ` (${reason.last.message})` : ''}.`;
    } else {
      code = 'POLICY_RULES';
      text = `${c.free} slot${c.free === 1 ? ' is' : 's are'} free, but none could be used without breaking a hard rule.`;
    }
  } else {
    const worst = Object.entries({ faculty: c.faculty, batch: c.batch, room: c.room }).sort((a, b) => b[1] - a[1])[0][0];
    code = { faculty: 'FACULTY_BUSY', batch: 'DIVISION_BUSY', room: 'NO_ROOM' }[worst];
    text = blockedText(model, i, c, teachers);
  }
  return {
    code,
    text,
    slots: c,
    teachers: shortCodes,
    engine: reason ? { code: reason.code ?? null, attempts: reason.attempts ?? null } : null,
    day_names: model.shape.days.map(dayName),
  };
}
