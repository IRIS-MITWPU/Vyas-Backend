/**
 * Readiness report for a planner term. Pure, no I/O. Every check is an exported
 * function `(state) => Issue[]`, also collected in the `checks` object (keyed by issue code).
 *
 * `state` shape (plain JSON, snake_case, every array may be missing/null):
 *   {
 *     term: { start_date, end_date, working_days, day_start_min, day_end_min,
 *             grid_minutes, theory_minutes, lab_minutes, breaks },      // see termDefaults.js
 *     rooms: [{ id, room_id, is_lab, name, building_name, capacity|null }],   // term room-pool rows joined with room info
 *     faculty: [{ id, short_code, full_name, profile_id|null, max_per_day|null, max_per_week|null }],  // faculty used in the term
 *     subjects: [{ id, code, name, kind: 'theory'|'lab', duration_min, weekly_count, semester_total|null }],
 *     divisions: [{ id, semester, name, student_count, home_room_id|null, home_room2_id|null (or home_room_ids: [..]),
 *                   batches: [{ id, name, student_count, is_whole }] }],
 *     offerings: [{ id, division_id, subject_id, weekly_count|null, per_batch,
 *                   faculty: [{ batch_id|null, faculty_id, role }] }]
 *   }
 *
 * Issue = { code, severity: 'error'|'warning'|'info', message, entity: {type, id, tab}, meta? }
 * For room issues entity.id is the pool row id (`rooms[].id`); meta.room_id carries the physical room id.
 *
 * Report = { ready, counts:{errors,warnings,info}, errors, warnings, info, stats }.
 */

import { teachableMinutesPerDay, termWeeks, workingDays, defaultDurationFor } from './termDefaults.js';
import { expectedSessions, effectiveWeeklyCount, targetBatches } from './sessionSync.js';
import { homeRoomIds } from './homeRooms.js';

// ---------------------------------------------------------------- helpers

const arr = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined) : []);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function issue(code, severity, message, type, id, tab, meta) {
  const out = { code, severity, message, entity: { type, id: id ?? null, tab } };
  if (meta) out.meta = meta;
  return out;
}

function facultyLabel(f) {
  const name = (f && (f.full_name || f.short_code)) || 'Unknown faculty';
  return /^(prof|dr|mr|mrs|ms)\b/i.test(name) ? name : `Prof. ${name}`;
}
function subjectLabel(s) {
  if (!s) return 'an unknown subject';
  return s.code && s.name && s.code !== s.name ? `${s.name} (${s.code})` : s.name || s.code || 'an unknown subject';
}
function divisionLabel(d) {
  if (!d) return 'an unknown division';
  return `Division ${d.name}${d.semester ? ` (semester ${d.semester})` : ''}`;
}
function roomLabel(r) {
  const nm = r.name || r.room_id || r.id;
  return r.building_name ? `${r.building_name} / ${nm}` : String(nm);
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const hours = (min) => `${Math.round((min / 60) * 100) / 100}`;

function index(state) {
  const subjects = new Map(arr(state.subjects).map((x) => [x.id, x]));
  const divisions = new Map(arr(state.divisions).map((x) => [x.id, x]));
  const faculty = new Map(arr(state.faculty).map((x) => [x.id, x]));
  return { subjects, divisions, faculty };
}

function normState(state) {
  const s = state || {};
  return {
    term: s.term || {},
    rooms: arr(s.rooms),
    faculty: arr(s.faculty),
    subjects: arr(s.subjects),
    divisions: arr(s.divisions),
    offerings: arr(s.offerings),
  };
}

function hasDates(term) {
  return Boolean(term && term.start_date && term.end_date);
}

function subjectDuration(subject, term) {
  return isNum(subject && subject.duration_min) && subject.duration_min > 0
    ? subject.duration_min
    : defaultDurationFor(subject && subject.kind, term);
}

/** Number of sessions per faculty id, computed from expected sessions (lead and assist both count). */
export function facultyLoads(state) {
  const loads = new Map();
  for (const s of expectedSessions(normState(state))) {
    for (const fid of s.faculty_ids) loads.set(fid, (loads.get(fid) || 0) + 1);
  }
  return loads;
}

// ---------------------------------------------------------------- checks

/** OFFERING_NO_FACULTY (error): an offering (or some of its batches) has nobody assigned. */
export function offeringNoFaculty(state) {
  const st = normState(state);
  const { subjects, divisions } = index(st);
  const out = [];
  for (const o of st.offerings) {
    const division = divisions.get(o.division_id);
    const subject = subjects.get(o.subject_id);
    const batches = division ? targetBatches(o, division) : [];
    const rows = arr(o.faculty);
    const uncovered = batches.length
      ? batches.filter((b) => !rows.some((r) => r.batch_id === b.id || r.batch_id === null || r.batch_id === undefined))
      : rows.length
        ? []
        : [null];
    if (!uncovered.length) continue;
    const allUncovered = !batches.length || uncovered.length === batches.length;
    const where = `${subjectLabel(subject)} in ${divisionLabel(division)}`;
    out.push(
      issue(
        'OFFERING_NO_FACULTY',
        'error',
        allUncovered
          ? `${where} has no faculty assigned.`
          : `${where} has no faculty assigned for batch ${uncovered.map((b) => b.name).join(', ')}.`,
        'offering',
        o.id,
        'offerings',
        allUncovered ? undefined : { batches: uncovered.map((b) => b.name) },
      ),
    );
  }
  return out;
}

/** NO_DIVISIONS (error): the term has no divisions at all, so there is nothing to schedule. */
export function noDivisions(state) {
  const st = normState(state);
  if (st.divisions.length) return [];
  return [
    issue('NO_DIVISIONS', 'error', 'The term has no divisions yet. Add or import at least one division.', 'term', st.term.id ?? null, 'divisions'),
  ];
}

/** DIVISION_NO_OFFERINGS (error). */
export function divisionNoOfferings(state) {
  const st = normState(state);
  const used = new Set(st.offerings.map((o) => o.division_id));
  return st.divisions
    .filter((d) => !used.has(d.id))
    .map((d) =>
      issue('DIVISION_NO_OFFERINGS', 'error', `${divisionLabel(d)} has no subjects assigned.`, 'division', d.id, 'offerings'),
    );
}

/** SUBJECT_UNUSED (warning). */
export function subjectUnused(state) {
  const st = normState(state);
  const used = new Set(st.offerings.map((o) => o.subject_id));
  return st.subjects
    .filter((x) => !used.has(x.id))
    .map((x) =>
      issue('SUBJECT_UNUSED', 'warning', `${subjectLabel(x)} is not offered in any division.`, 'subject', x.id, 'subjects'),
    );
}

/** NO_ROOMS_IN_POOL (error). */
export function noRoomsInPool(state) {
  const st = normState(state);
  if (st.rooms.length) return [];
  return [
    issue('NO_ROOMS_IN_POOL', 'error', 'The room pool is empty. Add at least one room for this term.', 'term', st.term.id ?? null, 'rooms'),
  ];
}

function labOfferings(st) {
  const { subjects } = index(st);
  return st.offerings.filter((o) => {
    const s = subjects.get(o.subject_id);
    return s && s.kind === 'lab';
  });
}

/** NO_LAB_ROOM (error): lab offerings exist but there is no lab room in the pool. */
export function noLabRoom(state) {
  const st = normState(state);
  if (!labOfferings(st).length || st.rooms.some((r) => r.is_lab)) return [];
  return [
    issue(
      'NO_LAB_ROOM',
      'error',
      'There are lab subjects but no lab room in the room pool. Mark at least one room as a lab.',
      'term',
      st.term.id ?? null,
      'rooms',
    ),
  ];
}

/** NO_CLASSROOM_ROOM (warning): theory offerings exist but the pool has no non-lab room. */
export function noClassroomRoom(state) {
  const st = normState(state);
  const { subjects } = index(st);
  const hasTheory = st.offerings.some((o) => {
    const sub = subjects.get(o.subject_id);
    return sub && sub.kind !== 'lab';
  });
  if (!hasTheory || st.rooms.some((r) => !r.is_lab)) return [];
  return [
    issue(
      'NO_CLASSROOM_ROOM',
      'warning',
      'There are theory subjects but no classroom (non-lab room) in the room pool. Add a room that is not marked as a lab.',
      'term',
      st.term.id ?? null,
      'rooms',
    ),
  ];
}

/** LAB_ROOMS_INSUFFICIENT (warning): fewer lab rooms than the largest batch count among divisions with labs. */
export function labRoomsInsufficient(state) {
  const st = normState(state);
  const { divisions } = index(st);
  const labRooms = st.rooms.filter((r) => r.is_lab).length;
  let max = 0;
  let maxDivision = null;
  for (const o of labOfferings(st)) {
    const d = divisions.get(o.division_id);
    if (!d) continue;
    const n = arr(d.batches).filter((b) => !b.is_whole).length;
    if (n > max) {
      max = n;
      maxDivision = d;
    }
  }
  if (!max || labRooms >= max) return [];
  return [
    issue(
      'LAB_ROOMS_INSUFFICIENT',
      'warning',
      `${divisionLabel(maxDivision)} has ${plural(max, 'lab batch')} but the pool has only ${plural(labRooms, 'lab room')}, so its lab batches cannot run in parallel.`,
      'term',
      st.term.id ?? null,
      'rooms',
      { lab_rooms: labRooms, largest_batch_count: max },
    ),
  ];
}

/**
 * ROOM_TOO_SMALL (warning): per division and session kind, no pool room of the right kind
 * (lab rooms for lab subjects, other rooms for theory) is big enough for the largest group.
 * Skipped when there is no room of that kind, or when any such room has an unknown capacity.
 */
export function roomTooSmall(state) {
  const st = normState(state);
  const { subjects, divisions } = index(st);
  const out = [];
  for (const d of st.divisions) {
    const need = { theory: { n: 0, batch: null }, lab: { n: 0, batch: null } };
    for (const o of st.offerings.filter((x) => x.division_id === d.id)) {
      const subject = subjects.get(o.subject_id);
      if (!subject || effectiveWeeklyCount(o, subject) === 0) continue;
      const kind = subject.kind === 'lab' ? 'lab' : 'theory';
      for (const b of targetBatches(o, divisions.get(o.division_id))) {
        const size = b.is_whole ? d.student_count : b.student_count;
        if (isNum(size) && size > need[kind].n) need[kind] = { n: size, batch: b.is_whole ? null : b.name };
      }
    }
    for (const kind of ['theory', 'lab']) {
      const required = need[kind].n;
      const candidates = st.rooms.filter((r) => Boolean(r.is_lab) === (kind === 'lab'));
      if (!required || !candidates.length || candidates.some((r) => !isNum(r.capacity))) continue;
      const biggest = Math.max(...candidates.map((r) => r.capacity));
      if (biggest >= required) continue;
      const who = need[kind].batch ? `batch ${need[kind].batch} of ${divisionLabel(d)}` : divisionLabel(d);
      out.push(
        issue(
          'ROOM_TOO_SMALL',
          'warning',
          `No ${kind === 'lab' ? 'lab room' : 'classroom'} in the pool fits ${who}: it has ${required} students and the largest ${kind === 'lab' ? 'lab room' : 'classroom'} seats ${biggest}.`,
          'division',
          d.id,
          'rooms',
          { kind, required, largest_capacity: biggest, batch: need[kind].batch },
        ),
      );
    }
  }
  return out;
}

/** ROOM_CAPACITY_UNKNOWN (info): one per pool room with null capacity. */
export function roomCapacityUnknown(state) {
  return normState(state)
    .rooms.filter((r) => !isNum(r.capacity))
    .map((r) =>
      issue(
        'ROOM_CAPACITY_UNKNOWN',
        'info',
        `The capacity of ${roomLabel(r)} is not recorded, so room-size checks skip it.`,
        'room',
        r.id ?? r.room_id,
        'rooms',
        { room_id: r.room_id ?? null },
      ),
    );
}

/**
 * HOME_ROOM_NOT_IN_POOL (contract 10.3): a home classroom of a division that is not in the term's room pool. An ERROR when
 * none of the division's home rooms is usable (its theory could not be placed anywhere), else a warning.
 */
export function homeRoomNotInPool(state) {
  const st = normState(state);
  const byRoom = new Map(st.rooms.map((r) => [r.room_id ?? r.id, r]));
  const out = [];
  for (const d of st.divisions) {
    const ids = homeRoomIds(d);
    const usable = ids.filter((id) => byRoom.has(id) && !byRoom.get(id).is_lab);
    for (const id of ids) {
      if (byRoom.has(id)) continue;
      const none = usable.length === 0;
      out.push(
        issue(
          'HOME_ROOM_NOT_IN_POOL',
          none ? 'error' : 'warning',
          none
            ? `A home classroom of ${divisionLabel(d)} is not in this term's room pool, so its theory classes cannot be placed. Add it to the pool or change the division's home classrooms.`
            : `A home classroom of ${divisionLabel(d)} is not in this term's room pool.`,
          'division',
          d.id,
          'divisions',
          { home_room_id: id },
        ),
      );
    }
  }
  return out;
}

/** HOME_ROOM_IS_LAB: a home classroom that the term's pool marks as a lab room (labs are not used for theory). */
export function homeRoomIsLab(state) {
  const st = normState(state);
  const byRoom = new Map(st.rooms.map((r) => [r.room_id ?? r.id, r]));
  const out = [];
  for (const d of st.divisions) {
    const ids = homeRoomIds(d);
    const usable = ids.filter((id) => byRoom.has(id) && !byRoom.get(id).is_lab);
    for (const id of ids) {
      const r = byRoom.get(id);
      if (!r || !r.is_lab) continue;
      out.push(
        issue(
          'HOME_ROOM_IS_LAB',
          usable.length === 0 ? 'error' : 'warning',
          `${roomLabel(r)}, a home classroom of ${divisionLabel(d)}, is marked as a lab room in this term's pool, so theory cannot use it.`,
          'division',
          d.id,
          'divisions',
          { home_room_id: id },
        ),
      );
    }
  }
  return out;
}

/** NO_HOME_ROOM (warning): divisions without a home classroom use any classroom of the pool. One issue for the term. */
export function noHomeRoom(state) {
  const st = normState(state);
  const without = st.divisions.filter((d) => homeRoomIds(d).length === 0);
  if (!without.length) return [];
  const names = without.slice(0, 5).map((d) => d.name).join(', ');
  const more = without.length > 5 ? ` and ${without.length - 5} more` : '';
  return [
    issue(
      'NO_HOME_ROOM',
      'warning',
      `${plural(without.length, 'division')} (${names}${more}) ${without.length === 1 ? 'has' : 'have'} no home classroom, so ${without.length === 1 ? 'its' : 'their'} theory can use any classroom. Pick up to 2 home classrooms per division on the Divisions tab.`,
      'term',
      st.term.id ?? null,
      'divisions',
      { division_ids: without.map((d) => d.id) },
    ),
  ];
}

/** NO_BUILDING (warning): the term is not tied to a building. Only reported when the term row carries the field. */
export function noBuilding(state) {
  const st = normState(state);
  if (st.term.building_id !== null) return [];
  return [
    issue(
      'NO_BUILDING',
      'warning',
      'No building is set for this term, so rooms of any building can be used. Choose the building on the Settings tab.',
      'term',
      st.term.id ?? null,
      'settings',
    ),
  ];
}

/** FACULTY_WEEKLY_OVERLOAD (error): sessions per week > max_per_week. */
export function facultyWeeklyOverload(state) {
  const st = normState(state);
  const loads = facultyLoads(st);
  const out = [];
  for (const f of st.faculty) {
    const load = loads.get(f.id) || 0;
    if (isNum(f.max_per_week) && load > f.max_per_week) {
      out.push(
        issue(
          'FACULTY_WEEKLY_OVERLOAD',
          'error',
          `${facultyLabel(f)} has ${plural(load, 'session')} per week but the weekly limit is ${f.max_per_week}.`,
          'faculty',
          f.id,
          'faculty',
          { sessions: load, max_per_week: f.max_per_week },
        ),
      );
    }
  }
  return out;
}

/** FACULTY_DAILY_CAP_INFEASIBLE (error): sessions per week > max_per_day x working days. */
export function facultyDailyCapInfeasible(state) {
  const st = normState(state);
  const loads = facultyLoads(st);
  const days = workingDays(st.term).length;
  const out = [];
  for (const f of st.faculty) {
    const load = loads.get(f.id) || 0;
    if (isNum(f.max_per_day) && load > f.max_per_day * days) {
      out.push(
        issue(
          'FACULTY_DAILY_CAP_INFEASIBLE',
          'error',
          `${facultyLabel(f)} has ${plural(load, 'session')} per week but a daily limit of ${f.max_per_day} over ${plural(days, 'working day')} allows only ${f.max_per_day * days}.`,
          'faculty',
          f.id,
          'faculty',
          { sessions: load, max_per_day: f.max_per_day, working_days: days },
        ),
      );
    }
  }
  return out;
}

/**
 * DIVISION_HOURS_OVER_CAPACITY (error): per division, the largest weekly load of any batch
 * (sessions on that batch plus sessions on the whole batch) exceeds teachable time per week
 * (teachable minutes per day x working days).
 */
export function divisionHoursOverCapacity(state) {
  const st = normState(state);
  const { subjects } = index(st);
  const capacity = teachableMinutesPerDay(st.term) * workingDays(st.term).length;
  const sessions = expectedSessions(st);
  const offeringSubject = new Map(st.offerings.map((o) => [o.id, subjects.get(o.subject_id)]));
  const out = [];
  for (const d of st.divisions) {
    const batches = arr(d.batches);
    const whole = batches.find((b) => b.is_whole);
    const real = batches.filter((b) => !b.is_whole);
    const mine = new Set(st.offerings.filter((o) => o.division_id === d.id).map((o) => o.id));
    const minutesByBatch = new Map(batches.map((b) => [b.id, 0]));
    for (const s of sessions) {
      if (!mine.has(s.offering_id)) continue;
      const subj = offeringSubject.get(s.offering_id);
      minutesByBatch.set(s.batch_id, (minutesByBatch.get(s.batch_id) || 0) + subjectDuration(subj, st.term));
    }
    const wholeMin = whole ? minutesByBatch.get(whole.id) || 0 : 0;
    const groups = real.length ? real : whole ? [whole] : [];
    let worst = 0;
    let worstBatch = null;
    for (const b of groups) {
      const total = b.is_whole ? wholeMin : wholeMin + (minutesByBatch.get(b.id) || 0);
      if (total > worst) {
        worst = total;
        worstBatch = b;
      }
    }
    if (worst > capacity) {
      const who = worstBatch && !worstBatch.is_whole ? `Batch ${worstBatch.name} of ${divisionLabel(d)}` : divisionLabel(d);
      out.push(
        issue(
          'DIVISION_HOURS_OVER_CAPACITY',
          'error',
          `${who} needs ${hours(worst)} hours of sessions per week but only ${hours(capacity)} teachable hours are available.`,
          'division',
          d.id,
          'offerings',
          { required_minutes: worst, capacity_minutes: capacity, batch: worstBatch && !worstBatch.is_whole ? worstBatch.name : null },
        ),
      );
    }
  }
  return out;
}

/** SEMESTER_TOTAL_MISMATCH (warning): semester_total != effective weekly count x term weeks. Skipped without dates/total. */
export function semesterTotalMismatch(state) {
  const st = normState(state);
  const weeks = termWeeks(st.term);
  if (weeks === null) return [];
  const { subjects, divisions } = index(st);
  const out = [];
  for (const o of st.offerings) {
    const subject = subjects.get(o.subject_id);
    if (!subject || !isNum(subject.semester_total)) continue;
    const weekly = effectiveWeeklyCount(o, subject);
    const expected = weekly * weeks;
    if (expected === subject.semester_total) continue;
    out.push(
      issue(
        'SEMESTER_TOTAL_MISMATCH',
        'warning',
        `${subjectLabel(subject)} in ${divisionLabel(divisions.get(o.division_id))} has a semester total of ${subject.semester_total} but ${weekly} per week over ${plural(weeks, 'week')} gives ${expected}.`,
        'offering',
        o.id,
        'offerings',
        { semester_total: subject.semester_total, weekly_count: weekly, term_weeks: weeks, expected },
      ),
    );
  }
  return out;
}

/** FACULTY_NOT_LINKED (info): faculty without a linked login profile. */
export function facultyNotLinked(state) {
  return normState(state)
    .faculty.filter((f) => !f.profile_id)
    .map((f) =>
      issue(
        'FACULTY_NOT_LINKED',
        'info',
        `${facultyLabel(f)} is not linked to a Vyas user account (no matching email).`,
        'faculty',
        f.id,
        'faculty',
      ),
    );
}

/** LAB_KIND_MISMATCH (warning): lab subject with per_batch=false, or theory subject with per_batch=true. */
export function labKindMismatch(state) {
  const st = normState(state);
  const { subjects, divisions } = index(st);
  const out = [];
  for (const o of st.offerings) {
    const s = subjects.get(o.subject_id);
    if (!s) continue;
    const where = `${subjectLabel(s)} in ${divisionLabel(divisions.get(o.division_id))}`;
    if (s.kind === 'lab' && !o.per_batch) {
      out.push(
        issue('LAB_KIND_MISMATCH', 'warning', `${where} is a lab but is not set to run per batch, so the whole division attends together.`, 'offering', o.id, 'offerings'),
      );
    } else if (s.kind === 'theory' && o.per_batch) {
      out.push(
        issue('LAB_KIND_MISMATCH', 'warning', `${where} is a theory subject but is set to run per batch.`, 'offering', o.id, 'offerings'),
      );
    }
  }
  return out;
}

/** LAB_NO_BATCHES (warning): lab offering in a division that only has the whole batch. */
export function labNoBatches(state) {
  const st = normState(state);
  const { subjects, divisions } = index(st);
  const out = [];
  for (const o of st.offerings) {
    const s = subjects.get(o.subject_id);
    const d = divisions.get(o.division_id);
    if (!s || !d || s.kind !== 'lab') continue;
    if (arr(d.batches).some((b) => !b.is_whole)) continue;
    out.push(
      issue(
        'LAB_NO_BATCHES',
        'warning',
        `${subjectLabel(s)} is a lab but ${divisionLabel(d)} has no lab batches, so the whole division will be scheduled together.`,
        'offering',
        o.id,
        'offerings',
      ),
    );
  }
  return out;
}

/** NO_DATES (info): the term has no start/end date, so week-based checks are skipped. */
export function noDates(state) {
  const st = normState(state);
  if (hasDates(st.term)) return [];
  return [
    issue(
      'NO_DATES',
      'info',
      'The term has no start and end date, so semester totals cannot be checked against the calendar.',
      'term',
      st.term.id ?? null,
      'settings',
    ),
  ];
}

/** All checks keyed by issue code, in report order. */
export const checks = {
  OFFERING_NO_FACULTY: offeringNoFaculty,
  NO_DIVISIONS: noDivisions,
  DIVISION_NO_OFFERINGS: divisionNoOfferings,
  SUBJECT_UNUSED: subjectUnused,
  NO_ROOMS_IN_POOL: noRoomsInPool,
  NO_LAB_ROOM: noLabRoom,
  NO_CLASSROOM_ROOM: noClassroomRoom,
  LAB_ROOMS_INSUFFICIENT: labRoomsInsufficient,
  ROOM_TOO_SMALL: roomTooSmall,
  ROOM_CAPACITY_UNKNOWN: roomCapacityUnknown,
  HOME_ROOM_NOT_IN_POOL: homeRoomNotInPool,
  HOME_ROOM_IS_LAB: homeRoomIsLab,
  NO_HOME_ROOM: noHomeRoom,
  NO_BUILDING: noBuilding,
  FACULTY_WEEKLY_OVERLOAD: facultyWeeklyOverload,
  FACULTY_DAILY_CAP_INFEASIBLE: facultyDailyCapInfeasible,
  DIVISION_HOURS_OVER_CAPACITY: divisionHoursOverCapacity,
  SEMESTER_TOTAL_MISMATCH: semesterTotalMismatch,
  FACULTY_NOT_LINKED: facultyNotLinked,
  LAB_KIND_MISMATCH: labKindMismatch,
  LAB_NO_BATCHES: labNoBatches,
  NO_DATES: noDates,
};

export const ISSUE_CODES = Object.freeze(Object.keys(checks));

/** Runs every check and builds the report object of contract section 3 (without `success`). */
export function computeReadiness(state) {
  const st = normState(state);
  const all = [];
  for (const fn of Object.values(checks)) all.push(...fn(st));
  const errors = all.filter((i) => i.severity === 'error');
  const warnings = all.filter((i) => i.severity === 'warning');
  const info = all.filter((i) => i.severity === 'info');
  const assigned = new Set();
  for (const o of st.offerings) for (const f of arr(o.faculty)) if (f.faculty_id) assigned.add(f.faculty_id);
  return {
    ready: errors.length === 0,
    counts: { errors: errors.length, warnings: warnings.length, info: info.length },
    errors,
    warnings,
    info,
    stats: {
      divisions: st.divisions.length,
      subjects: st.subjects.length,
      faculty_assigned: assigned.size,
      offerings: st.offerings.length,
      rooms: st.rooms.length,
      lab_rooms: st.rooms.filter((r) => r.is_lab).length,
      sessions_required: expectedSessions(st).length,
      teachable_minutes_per_day: teachableMinutesPerDay(st.term),
      term_weeks: termWeeks(st.term),
    },
  };
}
