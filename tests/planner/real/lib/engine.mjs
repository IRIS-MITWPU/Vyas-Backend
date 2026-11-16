// The auto-placement engine. No I/O of its own: the caller injects `send(ops, clientId)` (POST .../ops) and
// `refetch()` (GET .../snapshot), so the same code runs against the live API and against the offline fake server.
//
// The server is the authority. The engine proposes ranked candidates from its own OccupancyModel and tries them one by one:
//   200                          -> the placement (and the room the server picked) is written back into the model
//   409 CLASH / NO_ROOM_AVAILABLE / 422 PLACEMENT_INVALID -> recorded, next candidate (model re-synced when it drifted)
//   409 SESSION_LOCKED           -> that unit is skipped
//   anything else                -> FatalApiError (a harness bug or an environment problem)
import { OccupancyModel } from './model.mjs';
import { labBlockCandidates, theoryCandidates, divisionOrder, facultyLoads } from './rank.mjs';
import { buildLabBlocks } from './rotation.mjs';
import { allStarts, cmpText, dayName, fmt } from './time.mjs';

export class FatalApiError extends Error {
  constructor(message, res) {
    super(message);
    this.name = 'FatalApiError';
    this.res = res;
  }
}

const SOFT_REJECT = new Set(['CLASH', 'NO_ROOM_AVAILABLE', 'PLACEMENT_INVALID']);
const MAX_RESYNCS = 40;
const RESYNC_EVERY_MISMATCHES = 5;

/**
 * @param {object} args
 * @param {object} args.snapshot  GET /versions/:id/snapshot body
 * @param {(ops:object[], clientId:string)=>Promise<{status:number, body:any}>} args.send
 * @param {()=>Promise<object>} args.refetch
 * @param {object} [args.options]  {labRooms:'auto'|'affinity', seed, roomsFor(info)->room_ids|null, maxTries:{lab,theory}, clientId, sharedLabs}
 * @param {(event:object)=>void} [args.log]
 */
export async function autoplace({ snapshot, send, refetch, options = {}, log = () => {} }) {
  const opt = {
    labRooms: 'auto',
    seed: 1,
    roomsFor: null,
    maxTries: { lab: 24, theory: 60 },
    clientId: 'real-autoplace',
    sharedLabs: true,
    ...options,
  };
  let model = new OccupancyModel(snapshot, { sharedLabs: opt.sharedLabs });
  const st = {
    requests: 0,
    ok_requests: 0,
    rejected: { CLASH: 0, NO_ROOM_AVAILABLE: 0, PLACEMENT_INVALID: 0, SESSION_LOCKED: 0 },
    model_mismatches: 0, // the model proposed it, the server refused
    resyncs: 0,
    room_choice_differs: 0, // server auto-picked another room than the model predicted
    shared_labs_disabled: false,
    affinity_fallbacks: 0,
    affinity_unmapped_sessions: 0,
    placed_now: 0,
  };
  const rejections = [];
  const reasons = new Map(); // session id -> {code, detail}
  let mismatchesSinceResync = 0;
  let sharedRoomSignals = 0;

  const key = (sid) => {
    const i = model.info.get(sid);
    return `${i.division_key}|${i.subject_code}|${i.batch_name ?? 'ALL'}|#${i.seq}`;
  };

  async function resync(why) {
    if (st.resyncs >= MAX_RESYNCS) return false;
    const snap = await refetch();
    st.resyncs += 1;
    mismatchesSinceResync = 0;
    model = new OccupancyModel(snap, { sharedLabs: opt.sharedLabs && !st.shared_labs_disabled });
    log({ type: 'resync', why, resyncs: st.resyncs });
    return true;
  }

  // Three refusals of a lab placement that joined an already shared room = the server does not share lab rooms (pre-8.7).
  async function noteSharedRoomSignal() {
    if (!model.sharedLabs) return null;
    sharedRoomSignals += 1;
    if (sharedRoomSignals < 3) return null;
    st.shared_labs_disabled = true;
    model.sharedLabs = false;
    log({ type: 'note', message: 'server treats lab rooms as exclusive (no contract 8.7 sharing): model switched to exclusive labs' });
    return resync('shared-labs-off');
  }

  // Decides what a refused request means for the model. Returns true when the model was rebuilt.
  async function onRefusal(res, sids, cand) {
    const code = res.body?.code;
    st.rejected[code] = (st.rejected[code] || 0) + 1;
    st.model_mismatches += 1;
    mismatchesSinceResync += 1;
    const d = res.body?.details || {};
    const opIndex = Number.isInteger(d.op_index) ? d.op_index : null;
    const rec = {
      sessions: sids.map(key),
      failed_session: opIndex !== null && sids[opIndex] ? key(sids[opIndex]) : null,
      day: cand.day,
      start: fmt(cand.start),
      status: res.status,
      code,
      message: res.body?.error ?? '',
      reason: d.reason ?? null,
    };
    rejections.push(rec);
    let drift = false;
    if (code === 'CLASH') {
      const conflicts = Array.isArray(d.conflicts) ? d.conflicts : [];
      // a holder the model does not know to be at that slot = state drift
      for (const c of conflicts) {
        const h = model.placed.get(c.session_id);
        if (!h || h.day !== cand.day || !(h.start < cand.end && h.end > cand.start)) drift = true;
      }
      // pre-8.7 server: lab rooms are exclusive -> a plain 'room' clash on a lab session that the model put into an already shared room
      const failing = opIndex !== null ? model.info.get(sids[opIndex]) : null;
      if (failing && failing.kind === 'lab' && cand.plan?.[opIndex]?.joined && !d.reason && conflicts.length && conflicts.every((c) => c.kind === 'room')) {
        const r = await noteSharedRoomSignal();
        if (r !== null) return r;
      }
    }
    if (code === 'NO_ROOM_AVAILABLE') {
      const failing = opIndex !== null ? model.info.get(sids[opIndex]) : null;
      if (failing && failing.kind === 'lab' && cand.plan?.[opIndex]?.joined) {
        const r = await noteSharedRoomSignal();
        if (r !== null) return r;
      }
    }
    if (drift || (mismatchesSinceResync >= RESYNC_EVERY_MISMATCHES)) return resync(drift ? 'state-drift' : 'mismatch-batch');
    return false;
  }

  // Generic "try the ranked candidates one by one" loop for one unit (a theory session or a lab block).
  async function placeUnit({ sids, makeCands, buildOps, maxTries, phase }) {
    const tried = new Set();
    let attempts = 0;
    let lastReject = null;
    for (;;) {
      const cands = makeCands().filter((c) => !tried.has(`${c.day}|${c.start}`));
      if (!cands.length) return { placed: false, code: attempts ? 'ALL_CANDIDATES_REJECTED' : 'NO_FEASIBLE_SLOT', lastReject, attempts };
      let rebuilt = false;
      for (const c of cands) {
        if (attempts >= maxTries) return { placed: false, code: 'TRY_LIMIT', lastReject, attempts };
        tried.add(`${c.day}|${c.start}`);
        attempts += 1;
        const ops = buildOps(c);
        st.requests += 1;
        const res = await send(ops, opt.clientId);
        if (res.status === 200 && res.body?.success) {
          st.ok_requests += 1;
          const results = res.body.results || [];
          ops.forEach((op, n) => {
            const sid = op.session_id;
            const info = model.info.get(sid);
            const room = results[n]?.room_id ?? c.plan?.[n]?.room_id ?? c.room_id ?? null;
            const predicted = c.plan?.[n]?.room_id ?? c.room_id;
            if (predicted && room && predicted !== room && !op.room_id) st.room_choice_differs += 1;
            model.place(sid, c.day, c.start, c.start + info.duration, room, model.isShareable(sid, room));
            reasons.delete(sid);
          });
          st.placed_now += ops.length;
          return { placed: true, cand: c, attempts };
        }
        const code = res.body?.code;
        if (res.status === 409 && code === 'SESSION_LOCKED') {
          st.rejected.SESSION_LOCKED += 1;
          rejections.push({ sessions: sids.map(key), day: c.day, start: fmt(c.start), status: 409, code, message: res.body?.error ?? '' });
          return { placed: false, code: 'SESSION_LOCKED', lastReject: res.body, attempts };
        }
        if (!SOFT_REJECT.has(code)) {
          throw new FatalApiError(`unexpected response ${res.status} ${code ?? ''} for ${phase}: ${res.body?.error ?? JSON.stringify(res.body)?.slice(0, 200)}`, res);
        }
        lastReject = { code, message: res.body?.error ?? '', reason: res.body?.details?.reason ?? null };
        rebuilt = await onRefusal(res, sids, c);
        if (rebuilt) break;
      }
      if (!rebuilt) return { placed: false, code: 'ALL_CANDIDATES_REJECTED', lastReject, attempts };
      // the model was rebuilt: someone else may already hold the sessions or the slot; skip sessions already placed
      if (sids.every((s) => model.isPlaced(s))) return { placed: true, cand: null, attempts };
    }
  }

  const unplacedOf = (sids) => sids.filter((s) => !model.isPlaced(s) && !model.info.get(s).locked);

  // ---- ordering ---------------------------------------------------------------------------------
  const order = divisionOrder(model);
  const loads = facultyLoads(model);
  const sessionsOf = new Map(order.map((d) => [d.id, []]));
  for (const i of model.info.values()) sessionsOf.get(i.division_id)?.push(i);

  const infoToBlockSession = (i) => ({
    id: i.id, batch_id: i.batch_id, batch_name: i.batch_name, offering_id: i.offering_id, subject_code: i.subject_code, seq: i.seq, faculty_ids: i.faculty_ids,
  });

  function affinityMap(sids) {
    if (opt.labRooms !== 'affinity' || !opt.roomsFor) return null;
    const m = new Map();
    for (const s of sids) {
      const rooms = opt.roomsFor(model.info.get(s));
      if (rooms && rooms.length) m.set(s, rooms);
      else st.affinity_unmapped_sessions += 1;
    }
    return m.size ? m : null;
  }

  async function placeLabBlock(sids, { strict, phase }) {
    const sessions = sids.map((s) => infoToBlockSession(model.info.get(s)));
    const block = { key: sids.map(key).join('+'), sessions }; // natural key: stable across re-seeds
    const run = (affinity) =>
      placeUnit({
        sids,
        phase,
        maxTries: opt.maxTries.lab,
        makeCands: () => labBlockCandidates(model, block, { strict, seed: opt.seed, affinity }),
        buildOps: (c) =>
          c.plan.map((p) => {
            const op = { op: 'place', session_id: p.sid, weekday: c.day, start_min: c.start };
            if (affinity?.has(p.sid)) op.room_id = p.room_id;
            return op;
          }),
      });
    const aff = affinityMap(sids);
    let r = await run(aff);
    if (!r.placed && aff && r.code !== 'SESSION_LOCKED') {
      st.affinity_fallbacks += 1;
      r = await run(null);
    }
    if (!r.placed) for (const s of sids) reasons.set(s, { code: r.code, last: r.lastReject, attempts: r.attempts });
    return r.placed;
  }

  async function placeTheory(sid, { strict, phase }) {
    const r = await placeUnit({
      sids: [sid],
      phase,
      maxTries: opt.maxTries.theory,
      makeCands: () => theoryCandidates(model, sid, { strict, seed: opt.seed }),
      buildOps: (c) => [{ op: 'place', session_id: sid, weekday: c.day, start_min: c.start }],
    });
    if (!r.placed) reasons.set(sid, { code: r.code, last: r.lastReject, attempts: r.attempts });
    return r.placed;
  }

  const progress = { labs: new Map(), theory: new Map() };

  try {

  // ---- phase 1: lab blocks (strict) -----------------------------------------------------------------
  for (const d of order) {
    const labs = sessionsOf.get(d.id).filter((i) => i.kind === 'lab' && !model.isPlaced(i.id) && !i.locked);
    if (!labs.length) continue;
    const blocks = buildLabBlocks(labs.map(infoToBlockSession));
    let placed = 0;
    for (const b of blocks) {
      const sids = unplacedOf(b.session_ids);
      if (!sids.length) continue;
      if (await placeLabBlock(sids, { strict: true, phase: 'lab-block' })) placed += sids.length;
    }
    progress.labs.set(d.id, { placed, total: labs.length });
    log({ type: 'division', phase: 'labs', division: d.key, placed, total: labs.length, blocks: blocks.length });
  }

  // ---- phase 2: lab leftovers, one session at a time, relaxed ----------------------------------------
  for (const d of order) {
    const left = sessionsOf.get(d.id).filter((i) => i.kind === 'lab' && !model.isPlaced(i.id) && !i.locked);
    if (!left.length) continue;
    let placed = 0;
    for (const i of left) {
      if (await placeLabBlock([i.id], { strict: false, phase: 'lab-single' })) placed += 1;
    }
    log({ type: 'division', phase: 'lab-leftovers', division: d.key, placed, total: left.length });
  }

  // ---- phase 3 + 4: theory, strict then relaxed ----------------------------------------------------------
  const heaviest = (i) => (i.faculty_ids.length ? Math.max(...i.faculty_ids.map((f) => loads.get(f) || 0)) : 0);
  const theoryOrder = (list) => [...list].sort((a, b) => heaviest(b) - heaviest(a) || (b.weekly ?? 0) - (a.weekly ?? 0) || cmpText(a.subject_code, b.subject_code) || a.seq - b.seq);
  for (const d of order) {
    const th = theoryOrder(sessionsOf.get(d.id).filter((i) => i.kind !== 'lab' && !model.isPlaced(i.id) && !i.locked));
    if (!th.length) continue;
    let placed = 0;
    for (const i of th) if (await placeTheory(i.id, { strict: true, phase: 'theory' })) placed += 1;
    progress.theory.set(d.id, { placed, total: th.length });
    log({ type: 'division', phase: 'theory', division: d.key, placed, total: th.length });
  }
  for (const d of order) {
    const th = theoryOrder(sessionsOf.get(d.id).filter((i) => i.kind !== 'lab' && !model.isPlaced(i.id) && !i.locked));
    if (!th.length) continue;
    let placed = 0;
    for (const i of th) if (await placeTheory(i.id, { strict: false, phase: 'theory-relaxed' })) placed += 1;
    log({ type: 'division', phase: 'theory-relaxed', division: d.key, placed, total: th.length });
  }
  // one last relaxed sweep for labs freed up by nothing, cheap and harmless
  for (const d of order) {
    for (const i of sessionsOf.get(d.id).filter((x) => x.kind === 'lab' && !model.isPlaced(x.id) && !x.locked)) {
      if (await placeLabBlock([i.id], { strict: false, phase: 'lab-single-final' })) log({ type: 'note', message: `late lab placement ${key(i.id)}` });
    }
  }

  } catch (e) {
    // a fatal answer from the server: keep what we know so the caller can write a run log before exiting
    if (e instanceof FatalApiError) e.partial = { stats: st, rejections, placed_now: st.placed_now };
    throw e;
  }

  // ---- result -----------------------------------------------------------------------------------
  const unplaced = [];
  for (const i of model.info.values()) {
    if (model.isPlaced(i.id)) continue;
    unplaced.push({ session_id: i.id, key: key(i.id), division: i.division_key, subject_code: i.subject_code, kind: i.kind, batch: i.batch_name, locked: i.locked, ...diagnose(model, i.id, reasons.get(i.id)) });
  }
  unplaced.sort((a, b) => cmpText(a.key, b.key));
  return { stats: st, rejections, unplaced, model, progress };
}

/** Is there any slot left that satisfies the hard rules (the relaxed candidate lists)? */
function hasPolicyCandidate(model, sid) {
  const i = model.info.get(sid);
  if (i.kind !== 'lab') return theoryCandidates(model, sid, { strict: false }).length > 0;
  const block = { key: sid, sessions: [{ id: sid }] };
  return labBlockCandidates(model, block, { strict: false }).length > 0;
}

/**
 * Why is this session still unplaced? Scans every valid slot of the week against the final model.
 * -> {code, text, slots:{total, free, faculty, batch, room}, teachers:[], engine}
 */
export function diagnose(model, sid, engineReason) {
  const i = model.info.get(sid);
  const starts = allStarts(model.shape, i.duration);
  const c = { total: 0, free: 0, faculty: 0, batch: 0, room: 0 };
  for (const day of model.shape.days) {
    for (const s of starts) {
      c.total += 1;
      const ev = model.evaluate(sid, day, s);
      if (ev.ok) c.free += 1;
      else if (ev.why in c) c[ev.why] += 1;
    }
  }
  const teachers = i.faculty_ids.map((f) => model.faculty.get(f)?.short_code ?? f);
  let code;
  let text;
  if (i.locked) {
    code = 'LOCKED';
    text = 'the session is locked and was left alone';
  } else if (c.free > 0 && !hasPolicyCandidate(model, sid)) {
    code = 'POLICY_RULES';
    text = `${c.free} slot(s) are free, but each breaks a hard rule (same subject twice a day, a second lab for the batch that day, or the teacher's max_per_day)`;
  } else if (c.free > 0) {
    code = engineReason?.code === 'TRY_LIMIT' ? 'TRY_LIMIT' : 'SERVER_REFUSED';
    text = `the model sees ${c.free} free slot(s), but the server refused every candidate tried (${engineReason?.last?.code ?? 'n/a'}: ${engineReason?.last?.message ?? ''})`;
  } else {
    const worst = Object.entries({ faculty: c.faculty, batch: c.batch, room: c.room }).sort((a, b) => b[1] - a[1])[0][0];
    code = { faculty: 'FACULTY_BUSY', batch: 'DIVISION_BUSY', room: 'NO_ROOM' }[worst];
    text = `no free slot of ${c.total}: teacher(s) ${teachers.join('+') || '-'} busy in ${c.faculty}, division/batch busy in ${c.batch}, no room in ${c.room}`;
  }
  return { code, text, slots: c, teachers, engine: engineReason ? { code: engineReason.code, attempts: engineReason.attempts } : null, day_names: model.shape.days.map(dayName) };
}
