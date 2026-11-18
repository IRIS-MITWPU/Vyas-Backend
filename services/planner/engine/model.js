// The planner's in-memory occupancy model (production port of tests/planner/real/lib/model.mjs). Pure, no I/O.
//
// It mirrors what the server enforces (contract 8.1.3 / 8.1.8 / 8.7). The generator plans against this model and
// commits through applyPlacements, which runs the same checks, so the server stays the authority.
//
// Keys: rooms are keyed by rooms.id (`room_id`) everywhere (NOT the planner_term_rooms row id).
//
// Step 2 of the promotion (parity guarded by tests/planner/unit/engine_parity.test.js): the automatic room choice is
// delegated to the domain `pickRoom` (domain/roomPick.js), which is the code the server uses. Known divergences between
// the harness' private room logic and the domain one (all irrelevant for real data, documented here on purpose):
//   * text compare: the domain uses the default locale, the harness 'en' (same order for ASCII names);
//   * capacity: the domain treats any finite number as "known" for classrooms, the harness only positive integers;
//   * theory home rooms (contract 10.3): a division WITH home classrooms uses only those (the harness only prefers its single home room);
//   * the shared-lab peak load now comes from domain/roomShare.js peakLoad (identical sweep: ends before starts at the same minute);
//   * the `sharedLabs=false` switch of the harness (pre-8.7 servers) is gone: lab sharing is always on (contract 8.7).
// Placement validity stays on engine/time.js validPlacement (hot loop); the domain checkPlacement is used for a final
// validation pass over the generated plan (generate.js).
import { termShape, validPlacement, cmpText } from './time.js';
import { pickRoom as domainPickRoom, isShareable as domainIsShareable, peakLoad, allHomeRoomIds, violatesHomeRooms } from '../domain/index.js';

const isCap = (c) => typeof c === 'number' && Number.isInteger(c) && c > 0;
const ov = (s1, e1, s2, e2) => s1 < e2 && e1 > s2;

/** Normalised static info about every session of a snapshot (independent of placement). */
export function buildSessionInfo(snapshot) {
  const divByBatch = new Map();
  const divisions = new Map();
  for (const d of snapshot.divisions || []) {
    divisions.set(d.id, d);
    for (const b of d.batches || []) divByBatch.set(b.id, { division: d, batch: b });
  }
  const offering = new Map((snapshot.offerings || []).map((o) => [o.id, o]));
  const subjectByCode = new Map((snapshot.subjects || []).map((s) => [s.code, s]));
  const info = new Map();
  for (const s of snapshot.sessions || []) {
    const o = offering.get(s.offering_id);
    const bi = divByBatch.get(s.batch_id);
    const division = bi?.division ?? divisions.get(o?.division_id);
    const batch = bi?.batch;
    const whole = !!batch?.is_whole;
    const subject = subjectByCode.get(s.subject_code);
    const need = whole ? division?.student_count : batch?.student_count;
    info.set(s.id, {
      id: s.id,
      division_id: division?.id,
      division_key: division ? `${division.semester}|${division.name}` : '?',
      division_name: division?.name ?? '?',
      semester: division?.semester ?? null,
      batch_id: s.batch_id,
      batch_name: s.batch_name ?? batch?.name,
      batch,
      whole,
      offering_id: s.offering_id,
      subject_id: o?.subject_id ?? subject?.id,
      subject_code: s.subject_code,
      subject_name: s.subject_name ?? subject?.name ?? s.subject_code,
      kind: s.kind,
      duration: s.duration_min,
      seq: s.seq,
      faculty_ids: (s.faculty || []).map((f) => f.faculty_id),
      need: Number.isFinite(need) && need > 0 ? need : 0,
      locked: !!s.locked,
      // every batch resource id the session occupies (contract 8.1.3)
      res: whole ? (division?.batches || []).map((b) => b.id) : [s.batch_id],
      weekly: o?.effective_weekly_count ?? null,
    });
  }
  return { info, divisions, divByBatch, offering };
}

/** A Map whose get() computes (and caches) the room load on demand: the domain pickRoom only looks at the rooms it needs. */
class LazyLoads extends Map {
  constructor(compute) {
    super();
    this.compute = compute;
  }

  get(id) {
    if (!super.has(id)) super.set(id, this.compute(id));
    return super.get(id);
  }
}

export class OccupancyModel {
  /**
   * @param snapshot  GET /versions/:id/snapshot body (or an equivalent object)
   * @param opts.skipPlaced  Set of session ids to treat as UNPLACED even if the snapshot has them placed
   *                         (regenerate_unlocked); the snapshot itself is never mutated.
   */
  constructor(snapshot, opts = {}) {
    this.term = snapshot.term;
    this.shape = termShape(snapshot.term);
    const si = buildSessionInfo(snapshot);
    this.info = si.info;
    this.divisions = si.divisions;
    this.rooms = new Map();
    for (const r of snapshot.rooms || []) {
      const id = r.room_id ?? r.id;
      this.rooms.set(id, { room_id: id, is_lab: !!r.is_lab, capacity: Number.isFinite(r.capacity) ? r.capacity : null, name: r.name, building_name: r.building_name ?? '' });
    }
    this.roomList = [...this.rooms.values()];
    this.reservedRooms = allHomeRoomIds(this.divisions); // every division's home rooms (the fallback pick avoids them)
    this.faculty = new Map((snapshot.faculty || []).map((f) => [f.id, f]));
    this.placed = new Map(); // sid -> {day, start, end, room_id, shared}
    this.facOcc = new Map(); // faculty id -> Map(sid -> {day,start,end})
    this.batOcc = new Map(); // batch resource id -> Map(sid -> ...)
    this.divOcc = new Map(); // division id -> Map(sid -> ...)
    this.roomOcc = new Map(); // room id -> Map(sid -> {day,start,end,shared,students})
    const skip = opts.skipPlaced instanceof Set ? opts.skipPlaced : null;
    for (const s of snapshot.sessions || []) {
      if (s.weekday === null || s.weekday === undefined || s.start_min === null || s.start_min === undefined) continue;
      if (skip && skip.has(s.id)) continue;
      const shared = this.isShareable(s.id, s.room_id);
      this.place(s.id, s.weekday, s.start_min, s.end_min, s.room_id, shared);
    }
  }

  /** Contract 8.7.1 for the session in the given room. */
  isShareable(sid, roomId) {
    const i = this.info.get(sid);
    const r = this.rooms.get(roomId);
    return !!i && !!r && domainIsShareable({ subject: { kind: i.kind }, poolRoom: r });
  }

  isPlaced(sid) {
    return this.placed.has(sid);
  }

  /** Registers a placement (also used to load already placed sessions). */
  place(sid, day, start, end, roomId, shared) {
    const i = this.info.get(sid);
    if (!i) return;
    if (this.placed.has(sid)) this.unplace(sid);
    const rec = { day, start, end };
    this.placed.set(sid, { day, start, end, room_id: roomId, shared: !!shared });
    const add = (map, key, val) => {
      let m = map.get(key);
      if (!m) map.set(key, (m = new Map()));
      m.set(sid, val);
    };
    for (const f of i.faculty_ids) add(this.facOcc, f, rec);
    for (const b of i.res) add(this.batOcc, b, rec);
    add(this.divOcc, i.division_id, rec);
    if (roomId) add(this.roomOcc, roomId, { ...rec, shared: !!shared, students: i.need });
  }

  unplace(sid) {
    const p = this.placed.get(sid);
    if (!p) return;
    const i = this.info.get(sid);
    for (const f of i.faculty_ids) this.facOcc.get(f)?.delete(sid);
    for (const b of i.res) this.batOcc.get(b)?.delete(sid);
    this.divOcc.get(i.division_id)?.delete(sid);
    if (p.room_id) this.roomOcc.get(p.room_id)?.delete(sid);
    this.placed.delete(sid);
  }

  /** Copy of the current placement record of a session (for exact rollback), or null. */
  recordOf(sid) {
    const p = this.placed.get(sid);
    return p ? { sid, ...p } : null;
  }

  /** Puts a session back exactly as `recordOf` saw it. */
  restore(rec) {
    this.place(rec.sid, rec.day, rec.start, rec.end, rec.room_id, rec.shared);
  }

  /** First placed session of `map` (id -> rec) that overlaps [start,end) on `day`, or null. */
  static firstOverlap(map, day, start, end, except) {
    if (!map) return null;
    for (const [sid, r] of map) if (sid !== except && r.day === day && ov(r.start, r.end, start, end)) return sid;
    return null;
  }

  /** Every placed session of `map` that overlaps [start,end) on `day` (except `except`). */
  static overlaps(map, day, start, end, except) {
    const out = [];
    if (!map) return out;
    for (const [sid, r] of map) if (sid !== except && r.day === day && ov(r.start, r.end, start, end)) out.push(sid);
    return out;
  }

  /** Faculty ids (of the session) that are busy at the slot. */
  busyFaculty(sid, day, start, end) {
    const i = this.info.get(sid);
    return i.faculty_ids.filter((f) => OccupancyModel.firstOverlap(this.facOcc.get(f), day, start, end, sid) !== null);
  }

  /** Is any batch resource of the session busy at the slot? Returns the holder session id or null. */
  batchHolder(sid, day, start, end) {
    const i = this.info.get(sid);
    for (const b of i.res) {
      const h = OccupancyModel.firstOverlap(this.batOcc.get(b), day, start, end, sid);
      if (h) return h;
    }
    return null;
  }

  /** Placed sessions that block the session at the slot through a teacher or a batch resource (not the room). Sorted ids. */
  holders(sid, day, start, end) {
    const i = this.info.get(sid);
    const out = new Set();
    for (const f of i.faculty_ids) for (const h of OccupancyModel.overlaps(this.facOcc.get(f), day, start, end, sid)) out.add(h);
    for (const b of i.res) for (const h of OccupancyModel.overlaps(this.batOcc.get(b), day, start, end, sid)) out.add(h);
    return [...out].sort();
  }

  /** {exclusiveBusy, sharedPeak} of a room at the slot (exclusive = any 'room' row; sharedPeak = peak concurrent 'lab_room' students). */
  roomLoad(roomId, day, start, end, except = null) {
    const m = this.roomOcc.get(roomId);
    let exclusiveBusy = false;
    const shared = [];
    if (m) {
      for (const [sid, r] of m) {
        if (sid === except || r.day !== day || !ov(r.start, r.end, start, end)) continue;
        if (r.shared) shared.push(r);
        else exclusiveBusy = true;
      }
    }
    // peak concurrent students of the overlapping shared rows (domain/roomShare.js peakLoad, half-open intervals)
    const rows = shared.map((r) => ({ start_min: r.start, end_min: r.end, students: r.students }));
    return { exclusiveBusy, sharedPeak: shared.length ? peakLoad(rows, { start_min: start, end_min: end }) : 0, anyShared: shared.length > 0 };
  }

  /**
   * Automatic room choice, delegated to the domain pickRoom (contract 8.1.8 + 8.7.4).
   * Returns {room_id, shared, joined} or {room_id:null, reason}. The generator never passes `currentRoomId`.
   */
  pickRoom(sid, day, start, end) {
    const i = this.info.get(sid);
    const loads = new LazyLoads((rid) => {
      const l = this.roomLoad(rid, day, start, end, sid);
      return { exclusiveBusy: l.exclusiveBusy, sharedPeak: l.sharedPeak, shared: l.anyShared };
    });
    const r = domainPickRoom({
      subject: { kind: i.kind },
      division: this.divisions.get(i.division_id),
      batch: i.batch,
      poolRooms: this.roomList,
      roomLoads: loads,
      reservedRoomIds: this.reservedRooms,
    });
    if (!r.room_id) return r;
    const shared = this.isShareable(sid, r.room_id);
    return { room_id: r.room_id, shared, joined: shared && !!loads.get(r.room_id)?.shared };
  }

  /** Can the session use this explicit room at the slot? (contract 8.7.3) -> {ok, shared} | {ok:false, reason} */
  checkRoom(sid, roomId, day, start, end) {
    const r = this.rooms.get(roomId);
    if (!r) return { ok: false, reason: 'ROOM_NOT_IN_POOL' };
    const info = this.info.get(sid);
    if (violatesHomeRooms({ subject: { kind: info.kind }, division: this.divisions.get(info.division_id), room_id: roomId })) return { ok: false, reason: 'ROOM_NOT_HOME' };
    const load = this.roomLoad(roomId, day, start, end, sid);
    const shared = this.isShareable(sid, roomId);
    if (shared) {
      if (load.exclusiveBusy) return { ok: false, reason: 'ROOM_BUSY' };
      if (load.sharedPeak + this.info.get(sid).need > r.capacity) return { ok: false, reason: 'ROOM_CAPACITY' };
      return { ok: true, shared: true, joined: load.anyShared };
    }
    if (load.exclusiveBusy || load.anyShared) return { ok: false, reason: 'ROOM_BUSY' };
    return { ok: true, shared: false };
  }

  /**
   * Evaluates one placement without changing the model. opts.room_id forces a room.
   * -> {ok, end, room_id, shared} | {ok:false, why:'placement'|'faculty'|'batch'|'room', detail}
   */
  evaluate(sid, day, start, opts = {}) {
    const i = this.info.get(sid);
    const pv = validPlacement(this.shape, i.duration, day, start);
    if (!pv.ok) return { ok: false, why: 'placement', detail: pv.reason };
    const end = pv.end;
    const bf = this.busyFaculty(sid, day, start, end);
    if (bf.length) return { ok: false, why: 'faculty', detail: bf };
    const bh = this.batchHolder(sid, day, start, end);
    if (bh) return { ok: false, why: 'batch', detail: bh };
    if (opts.room_id) {
      const c = this.checkRoom(sid, opts.room_id, day, start, end);
      if (!c.ok) return { ok: false, why: 'room', detail: c.reason };
      return { ok: true, end, room_id: opts.room_id, shared: c.shared, joined: !!c.joined };
    }
    const p = this.pickRoom(sid, day, start, end);
    if (!p.room_id) return { ok: false, why: 'room', detail: p.reason };
    return { ok: true, end, room_id: p.room_id, shared: p.shared, joined: !!p.joined };
  }

  /**
   * Tentatively places several sessions at the same slot, one after the other (so later ones see the shared
   * load of earlier ones), then rolls everything back. items: [{sid, room_id?}]
   * -> {ok:true, plan:[{sid, end, room_id, shared}]} | {ok:false, index, why, detail}
   */
  tryBlock(items, day, start) {
    const plan = [];
    let fail = null;
    for (let n = 0; n < items.length; n++) {
      const it = items[n];
      const ev = this.evaluate(it.sid, day, start, it.room_id ? { room_id: it.room_id } : {});
      if (!ev.ok) {
        fail = { ok: false, index: n, why: ev.why, detail: ev.detail };
        break;
      }
      plan.push({ sid: it.sid, end: ev.end, room_id: ev.room_id, shared: ev.shared, joined: ev.joined });
      this.place(it.sid, day, start, ev.end, ev.room_id, ev.shared);
    }
    for (const p of plan) this.unplace(p.sid);
    return fail ?? { ok: true, plan };
  }

  // ---- read helpers used by the ranking ---------------------------------------------------------

  /** Intervals {start,end} of the division's teaching on a day (all batches, overlaps merged later). */
  divisionDay(divId, day, except = null) {
    const out = [];
    const m = this.divOcc.get(divId);
    if (m) for (const [sid, r] of m) if (r.day === day && !(except && except.has(sid))) out.push({ start: r.start, end: r.end, sid });
    return out;
  }

  facultyDay(facId, day) {
    const out = [];
    const m = this.facOcc.get(facId);
    if (m) for (const [sid, r] of m) if (r.day === day) out.push({ start: r.start, end: r.end, sid });
    return out;
  }

  /** Placed sessions of one offering (any batch). */
  offeringPlacements(offeringId) {
    const out = [];
    for (const [sid, p] of this.placed) if (this.info.get(sid).offering_id === offeringId) out.push({ sid, ...p });
    return out;
  }

  roomName(roomId) {
    return this.rooms.get(roomId)?.name ?? null;
  }
}

/** Builds the model of a snapshot (the public constructor). */
export function buildModel(snapshot, opts = {}) {
  return new OccupancyModel(snapshot, opts);
}
