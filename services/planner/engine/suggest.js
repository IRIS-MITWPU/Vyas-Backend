// Candidate slots and suggestions for ONE session (contract 9.4). Pure, read-only (a placed session is taken out of
// the model for the evaluation and put back exactly, also on errors).
//
// candidatesFor(model, sid, config)         -> every slot passing the HARD checks (relaxed pass), ascending score:
//                                               [{weekday, start_min, end_min, room_id, room_name, score}]
// suggestionsFor(model, sid, config, {limit}) -> {suggestions:[{...candidate, reason, ops}], none_reason?}
// A lab session is suggested on its own (one batch); lab_per_day applies per batch. Scores have no seeded jitter.
import { buildEngineConfig } from './config.js';
import { theoryCandidates, labBlockCandidates, scoreOf } from './rank.js';
import { diagnose, facultyLabel } from './diagnose.js';

/** Runs fn with the session taken out of the model (if placed), restoring it exactly afterwards. */
function withRemoved(model, sid, fn) {
  const rec = model.recordOf(sid);
  if (rec) model.unplace(sid);
  try {
    return fn(rec);
  } finally {
    if (rec) model.restore(rec);
  }
}

const noJitter = (config) => {
  const cfg = config && config.weights && config.defaults && config.hard ? config : buildEngineConfig(config);
  return { ...cfg, weights: { ...cfg.weights, jitter: 0 } };
};

/** Internal candidate list with the penalty parts and meta (used for the reasons). Call inside withRemoved. */
function rawCandidates(model, sid, config) {
  const cfg = noJitter(config);
  const i = model.info.get(sid);
  if (i.kind === 'lab') {
    const block = { key: sid, sessions: [{ id: sid }] };
    return labBlockCandidates(model, block, { config: cfg, strict: false, seed: 0 }).map((c) => ({ ...c, room_id: c.plan[0].room_id, shared: c.plan[0].shared }));
  }
  return theoryCandidates(model, sid, { config: cfg, strict: false, seed: 0 });
}

const publicOf = (model, c) => ({
  weekday: c.day,
  start_min: c.start,
  end_min: c.end,
  room_id: c.room_id,
  room_name: model.roomName(c.room_id),
  score: Math.round(scoreOf(c.parts) * 100) / 100,
});

/** Every slot (and the room the model would choose) where the session passes all hard checks, best first. */
export function candidatesFor(model, sid, config) {
  return withRemoved(model, sid, () => rawCandidates(model, sid, config).map((c) => publicOf(model, c)));
}

const hours = (h) => `${Math.round(h * 10) / 10} h`;

/** A short human reason built from the penalty parts / meta of one candidate. */
function reasonOf(model, sid, c, config) {
  const cfg = noJitter(config);
  const i = model.info.get(sid);
  const D = cfg.defaults;
  const out = [];
  const room = model.roomName(c.room_id) ?? 'a room';
  const who = i.whole || !i.batch_name ? i.division_name : `${i.division_name} ${i.batch_name}`;
  if (i.kind === 'lab') out.push(c.shared ? `uses lab ${room} (shared by capacity)` : `uses lab ${room}`);
  else if (c.meta.home) out.push(`keeps ${who} in ${room}`);
  else out.push(`${who} moves to ${room}`);
  const idle = c.meta.idleAddedMin;
  if (idle > 0) out.push(`adds a ${idle} min idle gap`);
  else if (idle < 0) out.push(`closes ${-idle} min of idle gap`);
  else out.push('no new idle gap');
  if (c.meta.facultyId) {
    const name = model.faculty.get(c.meta.facultyId)?.full_name ?? facultyLabel(model, c.meta.facultyId);
    const h = c.meta.facultyHoursAfter;
    out.push(h > D.facultyDefaultMaxHours ? `${name} reaches ${hours(h)} that day` : `${name} stays at ${hours(h)} that day`);
  }
  if (c.parts.runDivision > 0) out.push(`makes a long run of classes for ${who}`);
  if (c.parts.runFaculty > 0) out.push('a long unbroken stretch for a teacher');
  if (i.kind !== 'lab') {
    if (c.start >= D.lateStart) out.push('late in the day');
    else if (c.start < D.coreStart) out.push('early morning slot');
  }
  if (c.parts.dayOverload > 0) out.push(`${who} gets more than ${hours(D.maxDayHours)} that day`);
  return out.join(', ');
}

/**
 * Top suggestions for a session. A placed session gets alternatives (its current slot is not suggested) as
 * 'move' ops, an unplaced one 'place' ops. none_reason explains an empty list.
 */
export function suggestionsFor(model, sid, config, { limit = 5 } = {}) {
  const n = Math.max(1, Math.min(20, Math.floor(Number(limit)) || 5));
  const info = model.info.get(sid);
  return withRemoved(model, sid, (rec) => {
    if (info.locked) {
      const d = diagnose(model, sid, null, config);
      return { suggestions: [], none_reason: { code: 'LOCKED', text: 'This session is locked. Unlock it to move it.', slots: d.slots } };
    }
    const cfg = noJitter(config);
    const all = rawCandidates(model, sid, cfg).filter((c) => !(rec && c.day === rec.day && c.start === rec.start));
    if (!all.length) {
      const d = diagnose(model, sid, null, cfg, { ignoreSlot: rec ? { day: rec.day, start: rec.start } : null });
      const code = d.code === 'LOCKED' ? 'POLICY_RULES' : d.code;
      return { suggestions: [], none_reason: { code, text: d.text, slots: d.slots } };
    }
    const suggestions = all.slice(0, n).map((c) => ({
      ...publicOf(model, c),
      reason: reasonOf(model, sid, c, cfg),
      ops: [{ op: rec ? 'move' : 'place', session_id: sid, weekday: c.day, start_min: c.start, room_id: c.room_id }],
    }));
    return { suggestions };
  });
}
