// Quality metrics of a (partly) placed timetable, computed from a snapshot alone. Pure, no I/O.
//
// Definitions follow fixtures/real/pattern_stats.json so the two can be compared honestly:
//   panel = division (semester + name); theory slot = one theory session; lab block = all lab sessions of one
//   division that start together (parallel batches count as ONE block); "unit" = theory slot or lab block.
import { buildCtx, checkIntegrity, isPlacedSession, isSharedPlacement, studentsOf } from './integrity.mjs';
import { dayStats, fmt, termShape, dayName } from './time.mjs';

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const inc = (o, k, n = 1) => {
  o[k] = (o[k] || 0) + n;
};
const sortedObj = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en', { numeric: true })));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const LATE = 945;

/** Distinct lab blocks of a division: sessions grouped by (day, start). */
function labBlocksOf(sessions) {
  const m = new Map();
  for (const s of sessions) {
    if (s.kind !== 'lab') continue;
    const k = `${s.weekday}|${s.start_min}`;
    if (!m.has(k)) m.set(k, { day: s.weekday, start: s.start_min, end: s.end_min, sessions: [] });
    m.get(k).sessions.push(s);
  }
  return [...m.values()];
}

/** Metrics of one set of divisions (a semester, or everything). */
function groupMetrics(ctx, shape, groups) {
  const out = {
    panels: groups.length,
    theory_slots: 0,
    lab_blocks: 0,
    theory_slot_start_histogram: {},
    lab_block_start_histogram: {},
    theory_slots_per_weekday: {},
    lab_blocks_per_weekday: {},
    lab_block_parallel_batch_entries_histogram: {},
    subject_spread: { same_day_repeat_back_to_back: 0, same_day_repeat_split: 0, subject_slots_all_on_different_days: 0, subject_pairs_with_2plus_slots: 0, same_day_repeats_by_subject: {} },
    lab_rotation: { panels_with_lab_rotation: 0, every_batch_meets_every_lab_subject: 0, exactly_once_each: 0, lab_blocks_with_2plus_parallel_batches: 0, of_which_every_batch_on_a_different_subject: 0 },
  };
  for (const d of shape.days) {
    out.theory_slots_per_weekday[dayName(d)] = 0;
    out.lab_blocks_per_weekday[dayName(d)] = 0;
  }
  for (const g of groups) {
    const placed = g.sessions.filter(isPlacedSession);
    // theory
    const theory = placed.filter((s) => s.kind !== 'lab');
    for (const s of theory) {
      out.theory_slots += 1;
      inc(out.theory_slot_start_histogram, fmt(s.start_min));
      inc(out.theory_slots_per_weekday, dayName(s.weekday));
    }
    // subject spread
    const bySubject = new Map();
    for (const s of theory) {
      if (!bySubject.has(s.offering_id)) bySubject.set(s.offering_id, []);
      bySubject.get(s.offering_id).push(s);
    }
    for (const list of bySubject.values()) {
      if (list.length >= 2) {
        out.subject_spread.subject_pairs_with_2plus_slots += 1;
        if (new Set(list.map((s) => s.weekday)).size === list.length) out.subject_spread.subject_slots_all_on_different_days += 1;
      }
      const byDay = new Map();
      for (const s of list) {
        if (!byDay.has(s.weekday)) byDay.set(s.weekday, []);
        byDay.get(s.weekday).push(s);
      }
      for (const day of byDay.values()) {
        if (day.length < 2) continue;
        day.sort((a, b) => a.start_min - b.start_min);
        const adjacent = day.every((s, i) => i === 0 || s.start_min === day[i - 1].end_min);
        out.subject_spread[adjacent ? 'same_day_repeat_back_to_back' : 'same_day_repeat_split'] += 1;
        inc(out.subject_spread.same_day_repeats_by_subject, day[0].subject_code);
      }
    }
    // labs
    const blocks = labBlocksOf(placed);
    for (const b of blocks) {
      out.lab_blocks += 1;
      inc(out.lab_block_start_histogram, fmt(b.start));
      inc(out.lab_blocks_per_weekday, dayName(b.day));
      inc(out.lab_block_parallel_batch_entries_histogram, String(b.sessions.length));
      if (b.sessions.length >= 2) {
        out.lab_rotation.lab_blocks_with_2plus_parallel_batches += 1;
        if (new Set(b.sessions.map((s) => s.offering_id + '#' + s.seq)).size === b.sessions.length) out.lab_rotation.of_which_every_batch_on_a_different_subject += 1;
      }
    }
    // rotation per panel: panels with >= 2 batches that have lab sessions
    const labs = g.sessions.filter((s) => s.kind === 'lab');
    const batches = [...new Set(labs.map((s) => s.batch_id))];
    if (batches.length >= 2) {
      out.lab_rotation.panels_with_lab_rotation += 1;
      const subjects = [...new Set(labs.map((s) => s.subject_code))];
      const count = new Map();
      for (const s of labs.filter(isPlacedSession)) {
        const k = `${s.batch_id}|${s.subject_code}`;
        count.set(k, (count.get(k) || 0) + 1);
      }
      const pairs = batches.flatMap((b) => subjects.map((sub) => `${b}|${sub}`));
      if (pairs.every((k) => (count.get(k) || 0) >= 1)) out.lab_rotation.every_batch_meets_every_lab_subject += 1;
      if (pairs.every((k) => (count.get(k) || 0) === 1)) out.lab_rotation.exactly_once_each += 1;
    }
  }
  const units = out.theory_slots + out.lab_blocks;
  out.units = units;
  out.avg_theory_slots_plus_lab_blocks_per_panel_per_day_overall = groups.length ? r2(units / (groups.length * shape.days.length)) : 0;
  const lateOf = (h) => Object.entries(h).filter(([k]) => k >= '15:45').reduce((a, [, n]) => a + n, 0);
  out.share_theory_slots_starting_at_or_after_15_45 = out.theory_slots ? r3(lateOf(out.theory_slot_start_histogram) / out.theory_slots) : 0;
  out.share_lab_blocks_starting_at_or_after_15_45 = out.lab_blocks ? r3(lateOf(out.lab_block_start_histogram) / out.lab_blocks) : 0;
  out.share_all_cells_starting_at_or_after_15_45 = units ? r3((lateOf(out.theory_slot_start_histogram) + lateOf(out.lab_block_start_histogram)) / units) : 0;
  out.theory_slot_start_histogram = sortedObj(out.theory_slot_start_histogram);
  out.lab_block_start_histogram = sortedObj(out.lab_block_start_histogram);
  out.lab_block_parallel_batch_entries_histogram = sortedObj(out.lab_block_parallel_batch_entries_histogram);
  return out;
}

/**
 * @param snapshot  GET /versions/:id/snapshot body
 * @param opts.unplaced  optional unplaced list from the autoplace run log ([{session_id, key, code, text, teachers, division}])
 * @param opts.rejections optional list of rejections from the run log
 */
export function computeMetrics(snapshot, opts = {}) {
  const ctx = buildCtx(snapshot);
  const shape = termShape(snapshot.term);
  const sessions = snapshot.sessions || [];
  const placed = sessions.filter(isPlacedSession);
  const divKey = (s) => {
    const d = ctx.batchInfo.get(s.batch_id)?.division ?? ctx.divisions.get(ctx.offeringDivision.get(s.offering_id));
    return d ? `${d.semester}|${d.name}` : '?';
  };
  const divisions = new Map();
  for (const d of snapshot.divisions || []) divisions.set(`${d.semester}|${d.name}`, { key: `${d.semester}|${d.name}`, semester: d.semester, name: d.name, division: d, sessions: [] });
  for (const s of sessions) divisions.get(divKey(s))?.sessions.push(s);
  const groups = [...divisions.values()].sort((a, b) => a.semester - b.semester || a.name.localeCompare(b.name, 'en', { numeric: true }));

  const metrics = { generated_from: { rev: snapshot.rev ?? null, version_id: snapshot.version?.id ?? null, term: snapshot.term ? `${snapshot.term.academic_year} ${snapshot.term.half} ${snapshot.term.branch}` : null } };

  // ---- placement counts
  const unplacedList = sessions.filter((s) => !isPlacedSession(s));
  const byKind = { theory: 0, lab: 0 };
  for (const s of unplacedList) inc(byKind, s.kind === 'lab' ? 'lab' : 'theory');
  const reasonByCode = {};
  const reasonById = new Map((opts.unplaced || []).map((u) => [u.session_id, u]));
  for (const s of unplacedList) inc(reasonByCode, reasonById.get(s.id)?.code ?? 'UNKNOWN_NO_RUN_LOG');
  metrics.placement = {
    total: sessions.length,
    placed: placed.length,
    unplaced: unplacedList.length,
    placed_pct: sessions.length ? r2((100 * placed.length) / sessions.length) : 0,
    unplaced_by_kind: byKind,
    unplaced_by_reason: sortedObj(reasonByCode),
  };
  const rej = {};
  for (const r of opts.rejections || []) inc(rej, r.code ?? String(r.status));
  metrics.rejections_by_code = sortedObj(rej);
  metrics.rejections_total = (opts.rejections || []).length;

  // ---- pattern-style stats per semester and combined
  const semesters = [...new Set(groups.map((g) => g.semester))].sort((a, b) => a - b);
  metrics.per_semester = {};
  for (const sem of semesters) metrics.per_semester[`semester_${sem}`] = groupMetrics(ctx, shape, groups.filter((g) => g.semester === sem));
  metrics.combined = groupMetrics(ctx, shape, groups);

  // ---- per division: sessions/units/hours per day, runs, idle gaps
  const perDivision = [];
  const runHist = {};
  let divDays = 0;
  let divDaysOverRun = 0;
  let divDaysWithGap = 0;
  let idleMinTotal = 0;
  let divDaysOver6 = 0;
  for (const g of groups) {
    const pl = g.sessions.filter(isPlacedSession);
    const row = { division: g.key, sessions: g.sessions.length, placed: pl.length, sessions_per_day: {}, units_per_day: {}, hours_per_day: {}, longest_run_h: 0, idle_gap_days: 0, idle_hours: 0, labs_before_theory_days: 0 };
    for (const d of shape.days) {
      const dayS = pl.filter((s) => s.weekday === d);
      const st = dayStats(shape, dayS.map((s) => ({ start: s.start_min, end: s.end_min })));
      const blocks = labBlocksOf(dayS).length;
      const theory = dayS.filter((s) => s.kind !== 'lab').length;
      row.sessions_per_day[dayName(d)] = dayS.length;
      row.units_per_day[dayName(d)] = theory + blocks;
      row.hours_per_day[dayName(d)] = r2(st.hours);
      row.longest_run_h = Math.max(row.longest_run_h, st.maxRun);
      if (dayS.length) {
        divDays += 1;
        inc(runHist, String(Math.ceil(st.maxRun - 1e-9)));
        if (st.maxRun > 3) divDaysOverRun += 1;
        if (st.hours > 6) divDaysOver6 += 1;
        if (st.gaps > 0) {
          divDaysWithGap += 1;
          row.idle_gap_days += 1;
        }
        row.idle_hours += st.idle / 60;
        idleMinTotal += st.idle;
      }
    }
    row.idle_hours = r2(row.idle_hours);
    row.longest_run_h = r2(row.longest_run_h);
    perDivision.push(row);
  }
  metrics.per_division = perDivision;
  metrics.division_days = {
    with_teaching: divDays,
    longest_run_hours_histogram: sortedObj(runHist),
    days_with_run_over_3h: divDaysOverRun,
    days_over_6_teaching_hours: divDaysOver6,
    days_with_idle_gap: divDaysWithGap,
    total_idle_hours: r2(idleMinTotal / 60),
    avg_idle_hours_per_division_day: divDays ? r2(idleMinTotal / 60 / divDays) : 0,
    max_hours_in_a_day: r2(Math.max(0, ...perDivision.flatMap((p) => Object.values(p.hours_per_day)))),
    avg_hours_in_a_teaching_day: divDays ? r2(avg(perDivision.flatMap((p) => Object.values(p.hours_per_day).filter((h) => h > 0)))) : 0,
  };

  // ---- batch level lab rules
  let labTwiceSameDay = 0;
  let twoSubjectsSameDay = 0;
  const labByBatchDay = new Map();
  for (const s of placed.filter((x) => x.kind === 'lab')) {
    const k = `${s.batch_id}|${s.weekday}`;
    if (!labByBatchDay.has(k)) labByBatchDay.set(k, []);
    labByBatchDay.get(k).push(s);
  }
  for (const list of labByBatchDay.values()) {
    if (list.length >= 2) {
      labTwiceSameDay += 1;
      if (new Set(list.map((s) => s.subject_code)).size >= 2) twoSubjectsSameDay += 1;
    }
  }
  metrics.lab_rules = { batch_days_with_more_than_one_lab_session: labTwiceSameDay, batch_days_with_two_different_lab_subjects: twoSubjectsSameDay };

  // ---- teachers: day load, runs, spread
  const facSessions = new Map();
  for (const s of placed) for (const f of s.faculty || []) {
    if (!facSessions.has(f.faculty_id)) facSessions.set(f.faculty_id, []);
    facSessions.get(f.faculty_id).push(s);
  }
  const teacherRows = [];
  let teacherRunOver = 0;
  let teacherDays = 0;
  const teacherRunHist = {};
  for (const [fid, list] of facSessions) {
    const f = ctx.facultyById.get(fid);
    const hours = {};
    let longest = 0;
    for (const d of shape.days) {
      const dayS = list.filter((s) => s.weekday === d);
      const st = dayStats(shape, dayS.map((s) => ({ start: s.start_min, end: s.end_min })));
      hours[d] = st.hours;
      if (dayS.length) {
        teacherDays += 1;
        inc(teacherRunHist, String(Math.ceil(st.maxRun - 1e-9)));
        if (st.maxRun > 3) teacherRunOver += 1;
      }
      longest = Math.max(longest, st.maxRun);
    }
    const hv = shape.days.map((d) => hours[d]);
    const total = hv.reduce((a, b) => a + b, 0);
    teacherRows.push({ faculty: f?.short_code ?? fid, name: f?.full_name ?? '', weekly_hours: r2(total), max_day_h: r2(Math.max(...hv)), min_day_h: r2(Math.min(...hv)), avg_day_h: r2(total / hv.length), range_h: r2(Math.max(...hv) - Math.min(...hv)), longest_run_h: r2(longest) });
  }
  teacherRows.sort((a, b) => b.weekly_hours - a.weekly_hours || a.faculty.localeCompare(b.faculty));
  metrics.teachers = {
    count_teaching: teacherRows.length,
    avg_weekly_hours: r2(avg(teacherRows.map((t) => t.weekly_hours))),
    avg_daily_range_h: r2(avg(teacherRows.map((t) => t.range_h))),
    max_daily_hours_any_teacher: r2(Math.max(0, ...teacherRows.map((t) => t.max_day_h))),
    teacher_days_with_run_over_3h: teacherRunOver,
    teacher_days_with_teaching: teacherDays,
    longest_run_hours_histogram: sortedObj(teacherRunHist),
    top_loaded: teacherRows.slice(0, 15),
    all: teacherRows,
  };

  // ---- rooms
  const roomStat = new Map();
  for (const r of snapshot.rooms || []) roomStat.set(r.room_id ?? r.id, { room_id: r.room_id ?? r.id, name: r.name, is_lab: !!r.is_lab, capacity: r.capacity ?? null, hours: 0, sessions: 0, peak_students: 0, shared_hours: 0, triple_hours: 0 });
  const byRoomDay = new Map();
  for (const s of placed) {
    const rs = roomStat.get(s.room_id);
    if (!rs) continue;
    rs.hours += (s.end_min - s.start_min) / 60;
    rs.sessions += 1;
    const k = `${s.room_id}|${s.weekday}`;
    if (!byRoomDay.has(k)) byRoomDay.set(k, []);
    byRoomDay.get(k).push(s);
  }
  for (const [k, list] of byRoomDay) {
    const rs = roomStat.get(k.split('|')[0]);
    const cuts = [...new Set(list.flatMap((s) => [s.start_min, s.end_min]))].sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i];
      const b = cuts[i + 1];
      const live = list.filter((s) => s.start_min < b && s.end_min > a);
      if (!live.length) continue;
      const students = live.reduce((t, s) => t + studentsOf(ctx, s), 0);
      rs.peak_students = Math.max(rs.peak_students, students);
      if (live.length >= 2) rs.shared_hours += (b - a) / 60;
      if (live.length >= 3) rs.triple_hours += (b - a) / 60;
    }
  }
  const rooms = [...roomStat.values()].map((r) => ({ ...r, hours: r2(r.hours), shared_hours: r2(r.shared_hours), triple_hours: r2(r.triple_hours) }));
  const weekHours = shape.days.length * (shape.dayEnd - shape.dayStart - shape.breaks.reduce((a, b) => a + (b.end - b.start), 0)) / 60;
  const classrooms = rooms.filter((r) => !r.is_lab);
  const labRooms = rooms.filter((r) => r.is_lab);
  const homeOf = new Map((snapshot.divisions || []).map((d) => [d.id, d.home_room_id]));
  let theoryInHome = 0;
  let theoryWithHome = 0;
  for (const s of placed.filter((x) => x.kind !== 'lab')) {
    const home = homeOf.get(ctx.batchInfo.get(s.batch_id)?.division.id);
    if (!home) continue;
    theoryWithHome += 1;
    if (s.room_id === home) theoryInHome += 1;
  }
  const sharedSlots = labRooms.reduce((a, r) => a + r.shared_hours, 0);
  const labHoursTotal = labRooms.reduce((a, r) => a + r.hours, 0);
  metrics.rooms = {
    teachable_hours_per_week_per_room: r2(weekHours),
    classrooms: {
      in_pool: classrooms.length,
      used: classrooms.filter((r) => r.hours > 0).length,
      total_hours: r2(classrooms.reduce((a, r) => a + r.hours, 0)),
      avg_hours_per_used_room: r2(avg(classrooms.filter((r) => r.hours > 0).map((r) => r.hours))),
      max_hours_in_a_room: r2(Math.max(0, ...classrooms.map((r) => r.hours))),
      utilisation_of_used_rooms_pct: r2((100 * avg(classrooms.filter((r) => r.hours > 0).map((r) => r.hours))) / weekHours),
      theory_sessions_in_division_home_room: theoryInHome,
      theory_sessions_with_a_home_room: theoryWithHome,
      home_room_share: theoryWithHome ? r3(theoryInHome / theoryWithHome) : null,
    },
    lab_rooms: {
      in_pool: labRooms.length,
      used: labRooms.filter((r) => r.hours > 0).length,
      session_hours: r2(labHoursTotal),
      room_hours_with_two_or_more_groups: r2(sharedSlots),
      room_hours_with_three_or_more_groups: r2(labRooms.reduce((a, r) => a + r.triple_hours, 0)),
      peak_shared_students: Math.max(0, ...labRooms.map((r) => r.peak_students)),
      rooms_over_capacity: labRooms.filter((r) => Number.isFinite(r.capacity) && r.peak_students > r.capacity).map((r) => r.name),
      per_room: labRooms.filter((r) => r.hours > 0).sort((a, b) => b.hours - a.hours),
    },
    classroom_top: classrooms.filter((r) => r.hours > 0).sort((a, b) => b.hours - a.hours).slice(0, 10),
  };

  // ---- integrity, recomputed from the snapshot alone
  const integ = checkIntegrity(snapshot);
  metrics.integrity = { ok: integ.ok, violations: integ.violations.length, checked: integ.checked, first_violations: integ.violations.slice(0, 20) };

  // ---- unplaced listing
  metrics.unplaced_sessions = unplacedList.map((s) => {
    const u = reasonById.get(s.id);
    const d = ctx.batchInfo.get(s.batch_id)?.division ?? ctx.divisions.get(ctx.offeringDivision.get(s.offering_id));
    return {
      session_id: s.id,
      division: d ? `${d.semester}|${d.name}` : '?',
      subject: s.subject_code,
      kind: s.kind,
      batch: s.batch_name,
      seq: s.seq,
      teachers: (s.faculty || []).map((f) => f.short_code),
      reason_code: u?.code ?? 'UNKNOWN_NO_RUN_LOG',
      reason: u?.text ?? 'no autoplace run log available',
    };
  });
  return metrics;
}

// ---- comparison with the statistics of the hand-made grids ---------------------------------------------

function sumHist(list) {
  const out = {};
  for (const h of list) for (const [k, v] of Object.entries(h || {})) out[k] = (out[k] || 0) + v;
  return sortedObj(out);
}
const pct = (h) => {
  const t = Object.values(h).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, t ? r3(v / t) : 0]));
};

/** Combines pattern_stats.json (semester_3 + semester_5) into the same combined shape as computeMetrics().combined. */
export function combinePatternStats(ps) {
  const sems = [ps.semester_3, ps.semester_5].filter(Boolean);
  const panels = sems.reduce((a, s) => a + s.panels_analysed, 0);
  const theory = sems.reduce((a, s) => a + s.totals.theory_slots, 0);
  const labs = sems.reduce((a, s) => a + s.totals.lab_blocks, 0);
  const wavg = (key) => (panels ? r3(sems.reduce((a, s) => a + s[key] * s.panels_analysed, 0) / panels) : 0);
  return {
    panels,
    theory_slots: theory,
    lab_blocks: labs,
    theory_slot_start_histogram: sumHist(sems.map((s) => s.theory_slot_start_histogram)),
    lab_block_start_histogram: sumHist(sems.map((s) => s.lab_block_start_histogram)),
    lab_block_parallel_batch_entries_histogram: sumHist(sems.map((s) => s.lab_block_parallel_batch_entries_histogram)),
    avg_theory_slots_plus_lab_blocks_per_panel_per_day_overall: wavg('avg_theory_slots_plus_lab_blocks_per_panel_per_day_overall'),
    share_theory_slots_starting_at_or_after_15_45: theory ? r3(sems.reduce((a, s) => a + s.share_theory_slots_starting_at_or_after_15_45 * s.totals.theory_slots, 0) / theory) : 0,
    share_lab_blocks_starting_at_or_after_15_45: labs ? r3(sems.reduce((a, s) => a + s.share_lab_blocks_starting_at_or_after_15_45 * s.totals.lab_blocks, 0) / labs) : 0,
    share_all_cells_starting_at_or_after_15_45: theory + labs ? r3(sems.reduce((a, s) => a + s.share_all_cells_starting_at_or_after_15_45 * (s.totals.theory_slots + s.totals.lab_blocks), 0) / (theory + labs)) : 0,
    panels_with_a_subject_more_than_once_on_one_day: sems.reduce((a, s) => a + s.panels_with_a_subject_more_than_once_on_one_day, 0),
    same_day_repeat_back_to_back: sems.reduce((a, s) => a + s.subject_spread['same_day_repeat_back_to_back (adjacent slots)'], 0),
    same_day_repeat_split: sems.reduce((a, s) => a + s.subject_spread['same_day_repeat_split (not adjacent)'], 0),
    subject_slots_all_on_different_days: sems.reduce((a, s) => a + s.subject_spread.subject_slots_all_on_different_days, 0),
    panels_with_lab_rotation: sems.reduce((a, s) => a + s.lab_rotation.panels_with_lab_rotation, 0),
    every_batch_meets_every_lab_subject: sems.reduce((a, s) => a + s.lab_rotation.every_batch_meets_every_lab_subject, 0),
    exactly_once_each: sems.reduce((a, s) => a + s.lab_rotation['exactly_once_each (latin square)'], 0),
    lab_blocks_with_2plus_parallel_batches: sems.reduce((a, s) => a + s.lab_rotation.lab_blocks_with_2plus_parallel_batches, 0),
    of_which_every_batch_on_a_different_subject: sems.reduce((a, s) => a + s.lab_rotation.of_which_every_batch_on_a_different_subject, 0),
    theory_slots_per_weekday: sumHist(sems.map((s) => s.theory_slots_per_weekday)),
    lab_blocks_per_weekday: sumHist(sems.map((s) => s.lab_blocks_per_weekday)),
  };
}

/** Side-by-side rows [{metric, ours, admin, note}] of the headline metrics. */
export function comparisonRows(ours, admin) {
  const o = ours.combined;
  const rows = [];
  const add = (metric, a, b, note = '') => rows.push({ metric, ours: a, admin: b, note });
  add('panels (divisions)', o.panels, admin.panels);
  add('theory slots (1 h)', o.theory_slots, admin.theory_slots, 'the generated timetable places every required session; the grids hold the slot columns the admin wrote');
  add('lab blocks (parallel batches = 1 block)', o.lab_blocks, admin.lab_blocks);
  add('teaching units per panel per weekday', o.avg_theory_slots_plus_lab_blocks_per_panel_per_day_overall, admin.avg_theory_slots_plus_lab_blocks_per_panel_per_day_overall);
  add('share of theory slots starting at/after 15:45', o.share_theory_slots_starting_at_or_after_15_45, admin.share_theory_slots_starting_at_or_after_15_45);
  add('share of lab blocks starting at/after 15:45', o.share_lab_blocks_starting_at_or_after_15_45, admin.share_lab_blocks_starting_at_or_after_15_45);
  add('share of all cells starting at/after 15:45', o.share_all_cells_starting_at_or_after_15_45, admin.share_all_cells_starting_at_or_after_15_45);
  const sp = o.subject_spread;
  add('same subject twice a day, back to back', sp.same_day_repeat_back_to_back, admin.same_day_repeat_back_to_back, 'admin count includes the common 2-slot blocks (SCHIE, MCPT) that are not modelled here');
  add('same subject twice a day, split', sp.same_day_repeat_split, admin.same_day_repeat_split);
  add('subjects with all slots on different days', sp.subject_slots_all_on_different_days, admin.subject_slots_all_on_different_days, `ours counted over ${sp.subject_pairs_with_2plus_slots} (panel, subject) pairs with 2+ slots`);
  add('panels with a lab rotation (>=2 batches)', o.lab_rotation.panels_with_lab_rotation, admin.panels_with_lab_rotation);
  add('... every batch meets every lab subject', o.lab_rotation.every_batch_meets_every_lab_subject, admin.every_batch_meets_every_lab_subject);
  add('... exactly once each (Latin square)', o.lab_rotation.exactly_once_each, admin.exactly_once_each);
  add('parallel lab blocks (2+ batches)', o.lab_rotation.lab_blocks_with_2plus_parallel_batches, admin.lab_blocks_with_2plus_parallel_batches);
  add('... all batches on different subjects', o.lab_rotation.of_which_every_batch_on_a_different_subject, admin.of_which_every_batch_on_a_different_subject);
  return rows;
}

export const histogramShares = pct;
