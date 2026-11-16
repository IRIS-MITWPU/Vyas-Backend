// An in-process stand-in for POST /planner/versions/:id/ops and GET .../snapshot, used ONLY for offline tests and
// the `simulate.mjs` dry run. It implements contract 8.1 / 8.2 / 8.7 in the simplest possible way (brute-force clash
// scan from integrity.mjs, no shared code with the planner's incremental model) and answers with the same status codes
// and body shapes the real server uses.
//
// Options: sharedLabs (default true; false = pre-8.7 server, every room exclusive), failEvery (inject a CLASH on every
// n-th otherwise valid request to exercise the engine's refusal handling), maxOps.
import { buildCtx, conflictsAgainst, isPlacedSession, isSharedPlacement, peakLoad, studentsOf, batchResources } from './integrity.mjs';
import { validPlacement, termShape, cmpText, dayName, fmt } from './time.mjs';

const clone = (x) => JSON.parse(JSON.stringify(x));

export class FakeServer {
  constructor(snapshot, opts = {}) {
    this.snap = clone(snapshot);
    this.opts = { sharedLabs: true, failEvery: 0, ...opts };
    this.ctx = buildCtx(this.snap);
    this.shape = termShape(this.snap.term);
    this.byId = new Map(this.snap.sessions.map((s) => [s.id, s]));
    this.subjectByCode = new Map(this.snap.subjects.map((s) => [s.code, s]));
    this.requests = 0;
    this.validRequests = 0;
    this.log = [];
  }

  snapshot() {
    return clone(this.snap);
  }

  placed() {
    return this.snap.sessions.filter(isPlacedSession);
  }

  err(status, code, error, details) {
    return { status, body: { success: false, error, code, ...(details ? { details } : {}) } };
  }

  nameOf(kind, id) {
    if (kind === 'room') return this.ctx.rooms.get(id)?.name ?? id;
    if (kind === 'faculty') return this.ctx.facultyById.get(id)?.short_code ?? id;
    const bi = this.ctx.batchInfo.get(id);
    return bi ? `${bi.division.name}${bi.batch.is_whole ? '' : ` ${bi.batch.name}`}` : id;
  }

  /** The room the real server would auto-pick (contract 8.1.8 + 8.7.4), found by brute force. */
  pickRoom(s, others, day, start, end) {
    const subject = this.subjectByCode.get(s.subject_code);
    const isLab = subject.kind === 'lab';
    const division = this.ctx.batchInfo.get(s.batch_id).division;
    const need = studentsOf(this.ctx, s);
    const probe = { ...s, weekday: day, start_min: start, end_min: end };
    const free = (r) => conflictsAgainst(this.ctx, others, { ...probe, room_id: r.room_id }, { sharedLabs: this.opts.sharedLabs }).every((c) => c.kind !== 'room');
    const cap = (r) => Number.isInteger(r.capacity) && r.capacity > 0;
    const cmpName = (a, b) => cmpText(a.building_name, b.building_name) || cmpText(a.name, b.name);
    const pool = this.snap.rooms.filter((r) => !!r.is_lab === isLab);
    if (!pool.length) return null;
    if (isLab && this.opts.sharedLabs) {
      const sharedLoad = (r) =>
        peakLoad(
          others
            .filter((o) => isPlacedSession(o) && o.room_id === r.room_id && o.weekday === day && o.start_min < end && o.end_min > start && isSharedPlacement(this.ctx, o))
            .map((o) => ({ start: Math.max(o.start_min, start), end: Math.min(o.end_min, end), students: studentsOf(this.ctx, o) })),
        );
      const fit = pool.filter((r) => cap(r) && free(r)).sort((a, b) => sharedLoad(b) - sharedLoad(a) || a.capacity - b.capacity || cmpName(a, b));
      if (fit.length) return fit[0].room_id;
      const unknown = pool.filter((r) => !cap(r) && free(r)).sort(cmpName);
      return unknown.length ? unknown[0].room_id : null;
    }
    if (!isLab && division.home_room_id) {
      const home = pool.find((r) => r.room_id === division.home_room_id);
      if (home && free(home) && (!cap(home) || home.capacity >= need)) return home.room_id;
    }
    const ok = pool.filter((r) => free(r));
    const known = ok.filter((r) => cap(r) && r.capacity >= need).sort((a, b) => a.capacity - b.capacity || cmpName(a, b));
    if (known.length) return known[0].room_id;
    const unknown = ok.filter((r) => !cap(r)).sort(cmpName);
    return unknown.length ? unknown[0].room_id : null;
  }

  /** POST /planner/versions/:id/ops -> {status, body}. Atomic: any failing op restores the previous state. */
  async send(body) {
    this.requests += 1;
    const ops = body?.ops;
    if (!Array.isArray(ops) || ops.length < 1 || ops.length > 50) return this.err(400, 'VALIDATION_ERROR', 'ops: 1..50 required', { fieldErrors: { ops: ['1..50 ops required'] } });
    if (this.snap.version.status !== 'draft') return this.err(409, 'NOT_DRAFT', 'This version is not a draft.');
    const before = clone(this.snap.sessions);
    const prevRev = this.snap.rev;
    const changed = new Set();
    const results = [];
    const fail = (r) => {
      this.snap.sessions = before;
      this.byId = new Map(this.snap.sessions.map((s) => [s.id, s]));
      return r;
    };
    for (const [i, op] of ops.entries()) {
      const s = this.byId.get(op.session_id);
      if (!s) return fail(this.err(404, 'NOT_FOUND', 'Session not found in this version', { op_index: i }));
      if (op.op === 'unplace') {
        if (s.locked) return fail(this.err(409, 'SESSION_LOCKED', 'locked', { op_index: i }));
        if (isPlacedSession(s)) {
          Object.assign(s, { weekday: null, start_min: null, end_min: null, room_id: null });
          changed.add(s.id);
        }
        results.push({ index: i, session_id: s.id, room_id: null });
        continue;
      }
      if (op.op !== 'place' && op.op !== 'move') return fail(this.err(400, 'VALIDATION_ERROR', `unsupported op ${op.op}`, { fieldErrors: { op: ['unsupported in fake'] } }));
      if (s.locked) return fail(this.err(409, 'SESSION_LOCKED', 'locked', { op_index: i }));
      const pv = validPlacement(this.shape, s.duration_min, op.weekday, op.start_min);
      if (!pv.ok) return fail(this.err(422, 'PLACEMENT_INVALID', `placement invalid: ${pv.reason}`, { op_index: i, reason: pv.reason }));
      if (op.room_id && !this.ctx.rooms.has(op.room_id)) return fail(this.err(422, 'PLACEMENT_INVALID', 'room not in pool', { op_index: i, reason: 'ROOM_NOT_IN_POOL' }));
      const others = this.snap.sessions.filter((x) => x.id !== s.id);
      let roomId = op.room_id ?? null;
      if (!roomId) {
        roomId = this.pickRoom(s, others, op.weekday, op.start_min, pv.end);
        if (!roomId) return fail(this.err(409, 'NO_ROOM_AVAILABLE', 'No room is free at that time.', { op_index: i }));
      }
      const cand = { ...s, weekday: op.weekday, start_min: op.start_min, end_min: pv.end, room_id: roomId };
      const cs = conflictsAgainst(this.ctx, others, cand, { sharedLabs: this.opts.sharedLabs });
      if (cs.length) {
        const reason = cs.find((c) => c.reason)?.reason;
        const conflicts = cs.map((c) => ({
          kind: c.kind,
          resource_id: c.resource_id,
          resource_name: this.nameOf(c.kind, c.resource_id),
          session_id: c.holder.id,
          text: `${this.nameOf(c.kind, c.resource_id)} is busy: ${c.holder.subject_code} on ${dayName(c.holder.weekday)} ${fmt(c.holder.start_min)}-${fmt(c.holder.end_min)}.`,
        }));
        return fail(this.err(409, 'CLASH', conflicts[0].text, { op_index: i, conflicts, ...(reason ? { reason } : {}) }));
      }
      Object.assign(s, { weekday: op.weekday, start_min: op.start_min, end_min: pv.end, room_id: roomId });
      changed.add(s.id);
      results.push({ index: i, session_id: s.id, room_id: roomId });
    }
    this.validRequests += 1;
    if (this.opts.failEvery && this.validRequests % this.opts.failEvery === 0) {
      // simulated race: someone else grabbed the slot
      const first = ops[0];
      return fail(this.err(409, 'CLASH', 'That slot was just taken by another change. Refresh and try again.', { op_index: 0, conflicts: [{ kind: 'room', resource_id: 'x', resource_name: 'x', session_id: 'unknown-session', text: 'injected', op: first.op }] }));
    }
    if (!changed.size) return { status: 200, body: { success: true, rev: prevRev, prev_rev: prevRev, sessions: [], results } };
    this.snap.rev = prevRev + 1;
    return { status: 200, body: { success: true, rev: this.snap.rev, prev_rev: prevRev, sessions: clone(this.snap.sessions.filter((x) => changed.has(x.id))), results } };
  }
}

export { batchResources };
