// The planner's own in-memory occupancy model. Pure (no I/O).
//
// It mirrors what the server enforces (contract 8.1.3 / 8.1.8 / 8.7) so that most proposals are valid, but the
// server stays the authority: whatever it answers is written back with place()/unplace()/rebuild.
//
// Keys: rooms are keyed by rooms.id (`room_id`) everywhere (NOT the planner_term_rooms row id).
import { termShape, validPlacement, cmpText } from './time.mjs';

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
      batch_id: s.batch_id,
      batch_name: s.batch_name ?? batch?.name,
      whole,
      offering_id: s.offering_id,
      subject_id: o?.subject_id ?? subject?.id,
      subject_code: s.subject_code,
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

export class OccupancyModel {
  /**
   * @param snapshot  GET /versions/:id/snapshot body (or an equivalent object)
   * @param opts.sharedLabs  contract 8.7 lab sharing by capacity (default true)
   */
  constructor(snapshot, opts = {}) {
    this.sharedLabs = opts.sharedLabs !== false;
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
    this.faculty = new Map((snapshot.faculty || []).map((f) => [f.id, f]));
    this.placed = new Map(); // sid -> {day, start, end, room_id, shared}
    this.facOcc = new Map(); // faculty id -> Map(sid -> {day,start,end})
    this.batOcc = new Map(); // batch resource id -> Map(sid -> ...)
    this.divOcc = new Map(); // division id -> Map(sid -> ...)
    this.roomOcc = new Map(); // room id -> Map(sid -> {day,start,end,shared,students})
    for (const s of snapshot.sessions || []) {
      if (s.weekday === null || s.weekday === undefined || s.start_min === null || s.start_min === undefined) continue;
      const shared = this.isShareable(s.id, s.room_id);
      this.place(s.id, s.weekday, s.start_min, s.end_min, s.room_id, shared);
    }
  }

  /** Contract 8.7.1 for the session in the given room. */
  isShareable(sid, roomId) {
    if (!this.sharedLabs) return false;
    const i = this.info.get(sid);
    const r = this.rooms.get(roomId);
    return !!i && !!r && i.kind === 'lab' && r.is_lab && isCap(r.capacity);
  }

  isPlaced(sid) {
    return this.placed.has(sid);
  }

  /** Registers a placement (also used to load already placed sessions and to write back server results). */
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

  /** First placed session of `map` (id -> rec) that overlaps [start,end) on `day`, or null. */
  static firstOverlap(map, day, start, end, except) {
    if (!map) return null;
    for (const [sid, r] of map) if (sid !== except && r.day === day && ov(r.start, r.end, start, end)) return sid;
    return null;
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

  /** {exclusiveBusy, sharedPeak} of a room at the slot (exclusive = any 'room' row; sharedPeak = peak concurrent 'lab_room' students). */
  roomLoad(roomId, day, start, end, except = null) {
    const m = this.roomOcc.get(roomId);
    let exclusiveBusy = false;
    let shared = [];
    if (m) {
      for (const [sid, r] of m) {
        if (sid === except || r.day !== day || !ov(r.start, r.end, start, end)) continue;
        if (r.shared) shared.push(r);
        else exclusiveBusy = true;
      }
    }
    return { exclusiveBusy, sharedPeak: sharedPeak(shared, start, end), anyShared: shared.length > 0 };
  }

  /**
   * Automatic room choice, mirroring contract 8.1.8 + 8.7.4. Returns {room_id, shared} or {room_id:null, reason}.
   * Theory: home room (if free and big enough), else the smallest free classroom that fits (unknown capacity last).
   * Lab (sharing on): among lab rooms with known capacity that still fit -> the fullest one (largest shared peak,
   * then smallest capacity, then name); unknown capacity only when nothing else fits (exclusive).
   */
  pickRoom(sid, day, start, end) {
    const i = this.info.get(sid);
    const isLab = i.kind === 'lab';
    const need = i.need;
    const loads = new Map();
    const load = (r) => {
      if (!loads.has(r.room_id)) loads.set(r.room_id, this.roomLoad(r.room_id, day, start, end, sid));
      return loads.get(r.room_id);
    };
    const nameCmp = (a, b) => cmpText(a.building_name, b.building_name) || cmpText(a.name, b.name);
    const ofKind = this.roomList.filter((r) => r.is_lab === isLab);
    if (!ofKind.length) return { room_id: null, reason: `no ${isLab ? 'lab' : 'classroom'} in the pool` };

    if (isLab && this.sharedLabs) {
      const fit = ofKind
        .filter((r) => isCap(r.capacity) && !load(r).exclusiveBusy && load(r).sharedPeak + need <= r.capacity)
        .sort((a, b) => load(b).sharedPeak - load(a).sharedPeak || a.capacity - b.capacity || nameCmp(a, b));
      if (fit.length) return { room_id: fit[0].room_id, shared: true, joined: load(fit[0]).anyShared };
      const unknown = ofKind.filter((r) => !isCap(r.capacity) && !load(r).exclusiveBusy && !load(r).anyShared).sort(nameCmp);
      if (unknown.length) return { room_id: unknown[0].room_id, shared: false };
      return { room_id: null, reason: 'no free lab room with enough spare seats' };
    }
    const free = (r) => !load(r).exclusiveBusy && !load(r).anyShared;
    const div = this.divisions.get(i.division_id);
    if (!isLab && div?.home_room_id) {
      const home = this.rooms.get(div.home_room_id);
      if (home && !home.is_lab && free(home) && (!isCap(home.capacity) || home.capacity >= need)) return { room_id: home.room_id, shared: false };
    }
    const freeRooms = ofKind.filter(free);
    const known = freeRooms.filter((r) => isCap(r.capacity) && r.capacity >= need).sort((a, b) => a.capacity - b.capacity || nameCmp(a, b));
    if (known.length) return { room_id: known[0].room_id, shared: false };
    const unknown = freeRooms.filter((r) => !isCap(r.capacity)).sort(nameCmp);
    if (unknown.length) return { room_id: unknown[0].room_id, shared: false };
    return { room_id: null, reason: freeRooms.length ? 'no free room is big enough' : `all ${isLab ? 'lab rooms' : 'classrooms'} are in use` };
  }

  /** Can the session use this explicit room at the slot? (contract 8.7.3) -> {ok, shared} | {ok:false, reason} */
  checkRoom(sid, roomId, day, start, end) {
    const r = this.rooms.get(roomId);
    if (!r) return { ok: false, reason: 'ROOM_NOT_IN_POOL' };
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
   * Evaluates one placement without changing the model. opts.room_id forces a room (affinity mode).
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
   * load of earlier ones), then rolls everything back. items: [{sid, room_id?}] or [{sid, rooms:[ids]}] (first fitting).
   * -> {ok:true, plan:[{sid, end, room_id, shared}]} | {ok:false, index, why, detail}
   */
  tryBlock(items, day, start) {
    const plan = [];
    let fail = null;
    for (let n = 0; n < items.length; n++) {
      const it = items[n];
      let ev;
      if (it.rooms && it.rooms.length) {
        ev = { ok: false, why: 'room', detail: 'no affinity room fits' };
        for (const rid of it.rooms) {
          const e = this.evaluate(it.sid, day, start, { room_id: rid });
          if (e.ok) {
            ev = e;
            break;
          }
          if (e.why !== 'room') {
            ev = e;
            break;
          }
        }
      } else ev = this.evaluate(it.sid, day, start, it.room_id ? { room_id: it.room_id } : {});
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
}

/** Peak concurrent students of shared rows inside [start,end). */
function sharedPeak(rows, start, end) {
  if (!rows.length) return 0;
  const ev = [];
  for (const r of rows) {
    ev.push([Math.max(r.start, start), r.students]);
    ev.push([Math.min(r.end, end), -r.students]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let peak = 0;
  for (const [, d] of ev) {
    cur += d;
    if (cur > peak) peak = cur;
  }
  return peak;
}
