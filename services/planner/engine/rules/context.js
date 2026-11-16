// Shared, snapshot-derived lookups and helpers for the diagnostic rules. Pure, no DB, no I/O.
// Built once per evaluation (buildContext) and shared by every rule; each rule gets it through `Object.create`
// with its own `rule`, `params` and `severity` (see forRule), so `ctx.sessions`, `ctx.issue(...)` etc. work in check(ctx).
//
// A snapshot is the GET /versions/:id/snapshot body (contract 8.2). A session's room_id is the Vyas room
// (rooms[].room_id), not the term-pool row id. Weekday 0 = Monday, times are minutes since midnight.
import { termShape, unionIntervals, runContinues, idleBetween } from '../time.js';
import { fmtTime, weekdayName } from '../../domain/explain.js';
import { isShareable, studentsFor } from '../../domain/roomShare.js';

const hasNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 195 -> "3 h 15 min", 180 -> "3 h", 45 -> "45 min". */
export function fmtMinutes(min) {
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r} min`;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** Hours with at most one decimal: 3 -> "3", 3.25 -> "3.3". */
export const fmtHours = (hours) => String(Math.round(hours * 10) / 10);

export function buildContext(snapshot) {
  const snap = snapshot || {};
  const term = snap.term || {};
  const shape = termShape(term);

  const divisions = snap.divisions || [];
  const divById = new Map();
  const batchInfo = new Map();
  const divOrder = new Map();
  divisions.forEach((d, i) => {
    divById.set(d.id, d);
    divOrder.set(d.id, i);
    for (const b of d.batches || []) batchInfo.set(b.id, { division: d, batch: b });
  });
  const subjById = new Map((snap.subjects || []).map((s) => [s.id, s]));
  const offById = new Map((snap.offerings || []).map((o) => [o.id, o]));
  const roomByRoomId = new Map();
  for (const r of snap.rooms || []) roomByRoomId.set(r.room_id ?? r.id, r);
  const facById = new Map((snap.faculty || []).map((f) => [f.id, f]));

  // ---- normalised sessions
  const sessions = [];
  const byId = new Map();
  for (const s of snap.sessions || []) {
    const bi = batchInfo.get(s.batch_id);
    const off = offById.get(s.offering_id);
    const division = bi?.division ?? divById.get(off?.division_id) ?? null;
    const batch = bi?.batch ?? null;
    const subject = subjById.get(off?.subject_id) ?? null;
    const kind = s.kind ?? subject?.kind ?? off?.subject?.kind ?? 'theory';
    const placed = hasNum(s.weekday) && hasNum(s.start_min);
    const dur = hasNum(s.duration_min) ? s.duration_min : subject?.duration_min ?? null;
    const end = placed ? (hasNum(s.end_min) ? s.end_min : hasNum(dur) ? s.start_min + dur : s.start_min) : null;
    const room = s.room_id ? roomByRoomId.get(s.room_id) ?? null : null;
    const fac = [];
    for (const f of s.faculty || []) {
      if (!f || f.faculty_id == null || fac.includes(f.faculty_id)) continue;
      fac.push(f.faculty_id);
      if (!facById.has(f.faculty_id)) facById.set(f.faculty_id, { id: f.faculty_id, short_code: f.short_code, full_name: f.full_name, max_per_day: null, max_per_week: null });
    }
    const item = {
      id: s.id,
      s,
      offering: off ?? null,
      offering_id: s.offering_id,
      batch_id: s.batch_id,
      division,
      batch,
      isWhole: batch ? !!batch.is_whole : true,
      subject,
      kind,
      code: s.subject_code ?? subject?.code ?? off?.subject?.code ?? 'a session',
      placed,
      day: placed ? s.weekday : null,
      start: placed ? s.start_min : null,
      end,
      duration: dur,
      room,
      roomId: s.room_id ?? null,
      fac,
      students: studentsFor({ batch, division }),
      shared: isShareable({ subject: { kind }, poolRoom: room }),
    };
    sessions.push(item);
    byId.set(item.id, item);
  }
  const placedSessions = sessions.filter((x) => x.placed);

  // ---- lazy per-key indexes
  const memo = new Map();
  const group = (name, keyFn) => {
    if (!memo.has(name)) {
      const m = new Map();
      for (const x of placedSessions) {
        for (const k of keyFn(x)) {
          const list = m.get(k);
          if (list) list.push(x);
          else m.set(k, [x]);
        }
      }
      for (const list of m.values()) list.sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : 1));
      memo.set(name, m);
    }
    return memo.get(name);
  };

  return {
    snapshot: snap,
    term,
    shape,
    sessions,
    placedSessions,
    byId,
    divisions,
    divById,
    divOrder,
    batchInfo,
    facById,
    roomByRoomId,
    /** Map "<facultyId>|<day>" -> placed sessions of that faculty on that day (sorted by start). */
    facultyDays: () => group('fd', (x) => x.fac.map((f) => `${f}|${x.day}`)),
    /** Map "<divisionId>|<day>" -> placed sessions of the division (whole + every batch) on that day. */
    divisionDays: () => group('dd', (x) => (x.division ? [`${x.division.id}|${x.day}`] : [])),
    /** Map "<roomId>|<day>" -> placed sessions in that room on that day. */
    roomDays: () => group('rd', (x) => (x.roomId ? [`${x.roomId}|${x.day}`] : [])),

    // ---- names
    divLabel(d) {
      if (!d) return 'an unknown division';
      return d.semester != null && d.semester !== '' ? `${d.name} (Sem ${d.semester})` : String(d.name);
    },
    facLabel(id) {
      const f = facById.get(id);
      if (!f) return 'a teacher';
      const full = String(f.full_name ?? '').trim();
      const code = String(f.short_code ?? '').trim();
      if (full && code && full.toLowerCase() !== code.toLowerCase()) return `${full} (${code})`;
      return full || code || 'a teacher';
    },
    /** "DS Lab batch A1" / "DS" */
    sessLabel(x) {
      return !x.isWhole && x.batch?.name ? `${x.code} batch ${x.batch.name}` : x.code;
    },
    when(x) {
      return `${weekdayName(x.day)} ${fmtTime(x.start)}–${fmtTime(x.end)}`;
    },
    fmtTime,
    weekdayName,
    fmtMinutes,
    fmtHours,

    // ---- run / gap helpers with the semantics of engine/time.js dayStats
    /** Chains of back-to-back teaching: [{start, end, minutes}] (minutes = teaching minutes, as dayStats). */
    runsOf(intervals) {
      const u = unionIntervals(intervals);
      const runs = [];
      let cur = null;
      let prevEnd = null;
      for (const x of u) {
        const len = x.end - x.start;
        if (cur && runContinues(shape, prevEnd, x.start)) {
          cur.end = x.end;
          cur.minutes += len;
        } else {
          cur = { start: x.start, end: x.end, minutes: len };
          runs.push(cur);
        }
        prevEnd = x.end;
      }
      return runs;
    },
    /** Idle gaps between consecutive union intervals, breaks excluded: [{from, to, minutes}] (minutes > 0 only). */
    gapsOf(intervals) {
      const u = unionIntervals(intervals);
      const gaps = [];
      for (let i = 1; i < u.length; i++) {
        const g = idleBetween(shape, u[i - 1].end, u[i].start);
        if (g > 0) gaps.push({ from: u[i - 1].end, to: u[i].start, minutes: g });
      }
      return gaps;
    },
    /** Sessions of `list` overlapping [from, to). */
    within(list, from, to) {
      return list.filter((x) => x.start < to && x.end > from);
    },
    intervals: (list) => list.map((x) => ({ start: x.start, end: x.end })),

    // ---- issue factory (rule_key / severity come from the per-rule view, see forRule)
    /**
     * Issue = {id, rule_key, severity, message, session_ids, division_id, faculty_id, weekday, fix_hint?}.
     * id = rule_key + ':' + sorted session ids (+ ':f:' faculty id) (+ ':d:' division id when neither sessions nor a faculty identify it)
     * (+ ':w:' weekday) (+ ':x:' extra discriminator). `idSessions` overrides which sessions go into the id.
     * division: undefined = the common division of the sessions (else null); null/object/id = explicit.
     */
    issue({ sessions: list = [], message, division = undefined, faculty = null, weekday = null, fix_hint, idSessions, extra }) {
      const ids = [...new Set(list.map((x) => (typeof x === 'string' ? x : x.id)))].sort();
      const idIds = idSessions ? [...idSessions].sort() : ids;
      let division_id;
      if (division === undefined) {
        const set = new Set(list.map((x) => (typeof x === 'string' ? byId.get(x)?.division?.id : x.division?.id)).filter(Boolean));
        division_id = set.size === 1 ? [...set][0] : null;
      } else {
        division_id = division === null ? null : division.id ?? division;
      }
      let id = `${this.rule.rule_key}:${idIds.join(',')}`;
      if (faculty) id += `:f:${faculty}`;
      if (!idIds.length && !faculty && division_id) id += `:d:${division_id}`;
      if (weekday !== null && weekday !== undefined) id += `:w:${weekday}`;
      if (extra) id += `:x:${extra}`;
      const out = {
        id,
        rule_key: this.rule.rule_key,
        severity: this.severity,
        message,
        session_ids: ids,
        division_id,
        faculty_id: faculty ?? null,
        weekday: weekday ?? null,
      };
      if (fix_hint) out.fix_hint = fix_hint;
      return out;
    },
  };
}

/** Per-rule view of the shared context: adds `rule`, `params` and `severity`. */
export function forRule(world, rule) {
  const ctx = Object.create(world);
  ctx.rule = rule;
  ctx.params = rule.params || {};
  ctx.severity = rule.severity;
  return ctx;
}
