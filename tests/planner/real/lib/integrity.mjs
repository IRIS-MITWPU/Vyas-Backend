// Independent integrity checker: recomputes every clash from a snapshot alone with a plain pairwise scan.
// Deliberately shares no code with model.mjs (the planner's incremental model), so a model bug shows up as a
// violation here. The offline fake server (fakeServer.mjs) uses the same functions as its clash oracle, and
// analyze.mjs uses checkIntegrity() on the live snapshot. Pure.
import { dayName, fmt } from './time.mjs';

const isCap = (c) => typeof c === 'number' && Number.isInteger(c) && c > 0;

/** Lookup tables derived from a snapshot (divisions, batches, offerings, rooms). */
export function buildCtx(snapshot) {
  const batchInfo = new Map();
  const divisions = new Map();
  for (const d of snapshot.divisions || []) {
    divisions.set(d.id, d);
    for (const b of d.batches || []) batchInfo.set(b.id, { division: d, batch: b });
  }
  const offeringDivision = new Map((snapshot.offerings || []).map((o) => [o.id, o.division_id]));
  const rooms = new Map();
  for (const r of snapshot.rooms || []) rooms.set(r.room_id ?? r.id, r);
  const facultyById = new Map((snapshot.faculty || []).map((f) => [f.id, f]));
  return { batchInfo, divisions, offeringDivision, rooms, facultyById, term: snapshot.term };
}

/** Division object of a session (via its batch, falling back to its offering). */
export function divisionOf(ctx, s) {
  return ctx.batchInfo.get(s.batch_id)?.division ?? ctx.divisions.get(ctx.offeringDivision.get(s.offering_id));
}

/** Batch resource ids a session occupies (contract 8.1.3): whole batch -> whole + every non-whole batch. */
export function batchResources(ctx, s) {
  const info = ctx.batchInfo.get(s.batch_id);
  if (!info) return [s.batch_id];
  if (info.batch.is_whole) return info.division.batches.map((b) => b.id);
  return [s.batch_id];
}

/** Students the session brings into its room (whole batch -> division size). */
export function studentsOf(ctx, s) {
  const info = ctx.batchInfo.get(s.batch_id);
  if (!info) return 0;
  const n = info.batch.is_whole ? info.division.student_count : info.batch.student_count;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Contract 8.7.1: lab subject + lab pool room + positive integer capacity. */
export function isSharedPlacement(ctx, s, roomId = s.room_id) {
  const room = ctx.rooms.get(roomId);
  return s.kind === 'lab' && !!room && room.is_lab === true && isCap(room.capacity);
}

export const isPlacedSession = (s) => s.weekday !== null && s.weekday !== undefined && s.start_min !== null && s.start_min !== undefined;

const overlaps = (a, b) => a.weekday === b.weekday && a.start_min < b.end_min && a.end_min > b.start_min;

/** Max concurrent students of [{start,end,students}] over half-open intervals. */
export function peakLoad(items) {
  const ev = [];
  for (const it of items) {
    ev.push([it.start, it.students]);
    ev.push([it.end, -it.students]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // ends (negative) before starts at the same instant
  let cur = 0;
  let peak = 0;
  for (const [, d] of ev) {
    cur += d;
    if (cur > peak) peak = cur;
  }
  return peak;
}

/**
 * Would placing `cand` (a session-like {id,batch_id,offering_id,kind,faculty_ids,weekday,start_min,end_min,room_id}) clash
 * with the placed sessions in `placed`? Returns [{kind:'faculty'|'batch'|'room', holder, detail}], honouring
 * shared-lab capacity (8.7). `sharedLabs=false` makes every room exclusive (pre-8.7 behaviour).
 */
export function conflictsAgainst(ctx, placed, cand, { sharedLabs = true } = {}) {
  const out = [];
  const candFac = cand.faculty_ids ?? (cand.faculty || []).map((f) => f.faculty_id);
  const candRes = new Set(batchResources(ctx, cand));
  const candShared = sharedLabs && isSharedPlacement(ctx, cand);
  const sharedHolders = [];
  for (const o of placed) {
    if (o.id === cand.id || !isPlacedSession(o) || !overlaps(o, cand)) continue;
    const oFac = o.faculty_ids ?? (o.faculty || []).map((f) => f.faculty_id);
    const f = candFac.find((x) => oFac.includes(x));
    if (f) out.push({ kind: 'faculty', holder: o, resource_id: f });
    const res = batchResources(ctx, o).find((x) => candRes.has(x));
    if (res) out.push({ kind: 'batch', holder: o, resource_id: res });
    if (o.room_id && cand.room_id && o.room_id === cand.room_id) {
      const oShared = sharedLabs && isSharedPlacement(ctx, o);
      if (!(candShared && oShared)) out.push({ kind: 'room', holder: o, resource_id: cand.room_id });
      else sharedHolders.push(o);
    }
  }
  if (candShared) {
    const room = ctx.rooms.get(cand.room_id);
    const items = sharedHolders.map((o) => ({ start: o.start_min, end: o.end_min, students: studentsOf(ctx, o) }));
    const base = peakLoadWith(items, { start: cand.start_min, end: cand.end_min, students: studentsOf(ctx, cand) });
    if (base > room.capacity) out.push({ kind: 'room', holder: sharedHolders[0], resource_id: cand.room_id, reason: 'ROOM_CAPACITY', peak: base, capacity: room.capacity });
  }
  return out;
}

/** Peak concurrent load inside the candidate's own interval (existing items + the candidate). */
function peakLoadWith(items, cand) {
  const rel = items.filter((i) => i.start < cand.end && i.end > cand.start).map((i) => ({ ...i, start: Math.max(i.start, cand.start), end: Math.min(i.end, cand.end) }));
  return peakLoad([...rel, cand]);
}

/**
 * Full recomputation from a snapshot. Returns {ok, violations:[{type, text, ...}], checked:{placed, pairs}}.
 * type: FACULTY_CLASH | BATCH_CLASH | ROOM_CLASH | ROOM_CAPACITY | ROOM_MISSING | UNKNOWN_ROOM
 */
export function checkIntegrity(snapshot, { sharedLabs = true } = {}) {
  const ctx = buildCtx(snapshot);
  const sessions = (snapshot.sessions || []).filter(isPlacedSession);
  const violations = [];
  const label = (s) => `${s.subject_code} ${s.batch_name ?? ''}`.trim();
  const when = (s) => `${dayName(s.weekday)} ${fmt(s.start_min)}-${fmt(s.end_min)}`;
  let pairs = 0;

  const byDay = new Map();
  for (const s of sessions) {
    if (!byDay.has(s.weekday)) byDay.set(s.weekday, []);
    byDay.get(s.weekday).push(s);
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => a.start_min - b.start_min);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.start_min >= a.end_min) break;
        pairs += 1;
        const aFac = (a.faculty || []).map((f) => f.faculty_id);
        const bFac = (b.faculty || []).map((f) => f.faculty_id);
        const f = aFac.find((x) => bFac.includes(x));
        if (f) {
          const fac = ctx.facultyById.get(f);
          violations.push({ type: 'FACULTY_CLASH', sessions: [a.id, b.id], text: `${fac?.short_code ?? f} teaches ${label(a)} and ${label(b)} at ${when(a)}` });
        }
        const ra = batchResources(ctx, a);
        const rb = new Set(batchResources(ctx, b));
        if (ra.some((x) => rb.has(x))) violations.push({ type: 'BATCH_CLASH', sessions: [a.id, b.id], text: `${label(a)} and ${label(b)} share students at ${when(a)}` });
        if (a.room_id && a.room_id === b.room_id) {
          const sa = sharedLabs && isSharedPlacement(ctx, a);
          const sb = sharedLabs && isSharedPlacement(ctx, b);
          if (!(sa && sb)) violations.push({ type: 'ROOM_CLASH', sessions: [a.id, b.id], text: `room ${ctx.rooms.get(a.room_id)?.name ?? a.room_id} used by ${label(a)} and ${label(b)} at ${when(a)}` });
        }
      }
    }
  }
  // shared lab peak per room/day
  const perRoom = new Map();
  for (const s of sessions) {
    if (!sharedLabs || !isSharedPlacement(ctx, s)) continue;
    const key = `${s.room_id}|${s.weekday}`;
    if (!perRoom.has(key)) perRoom.set(key, []);
    perRoom.get(key).push({ start: s.start_min, end: s.end_min, students: studentsOf(ctx, s), id: s.id });
  }
  for (const [key, items] of perRoom) {
    const roomId = key.split('|')[0];
    const room = ctx.rooms.get(roomId);
    const peak = peakLoad(items);
    if (peak > room.capacity) violations.push({ type: 'ROOM_CAPACITY', sessions: items.map((i) => i.id), text: `lab room ${room.name} peaks at ${peak} students (capacity ${room.capacity}) on ${dayName(Number(key.split('|')[1]))}` });
  }
  for (const s of sessions) {
    if (!s.room_id) violations.push({ type: 'ROOM_MISSING', sessions: [s.id], text: `${label(s)} is placed without a room` });
    else if (!ctx.rooms.has(s.room_id)) violations.push({ type: 'UNKNOWN_ROOM', sessions: [s.id], text: `${label(s)} uses a room outside the term pool` });
  }
  return { ok: violations.length === 0, violations, checked: { placed: sessions.length, overlapping_pairs: pairs } };
}
