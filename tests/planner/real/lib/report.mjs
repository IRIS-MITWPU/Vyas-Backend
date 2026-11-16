// Markdown rendering of the run report. Pure string building (no I/O).
import { comparisonRows, combinePatternStats, histogramShares } from './metrics.mjs';

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');
const pc = (x) => (typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '-');
const list = (o) => (o && Object.keys(o).length ? Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(', ') : 'none');

function histCompare(oursHist, adminHist) {
  const keys = [...new Set([...Object.keys(oursHist), ...Object.keys(adminHist)])].sort();
  const a = histogramShares(oursHist);
  const b = histogramShares(adminHist);
  return table(['start', 'ours (count)', 'ours (share)', 'hand-made (count)', 'hand-made (share)'], keys.map((k) => [k, oursHist[k] ?? 0, pc(a[k] ?? 0), adminHist[k] ?? 0, pc(b[k] ?? 0)]));
}

/** Honest, data-driven discussion of the differences (every number comes from the two metric sets). */
export function discussion(m, admin) {
  const o = m.combined;
  const out = [];
  const diff = (a, b, tol) => (Math.abs(a - b) <= tol ? 'about the same as' : a > b ? 'higher than' : 'lower than');
  out.push(
    `- **Volume.** ${o.theory_slots} theory slots and ${o.lab_blocks} lab blocks were placed versus ${admin.theory_slots} and ${admin.lab_blocks} in the hand-made grids (${o.avg_theory_slots_plus_lab_blocks_per_panel_per_day_overall} vs ${admin.avg_theory_slots_plus_lab_blocks_per_panel_per_day_overall} units per panel per weekday). The model demand is the imported weekly counts (lab weekly_count 1 per batch, theory = the most common value over the panels), so it is not identical to what the admin actually wrote; common blocks (Cognitive Skills, SCHIE, MCPT), Eval, Mentor-Mentee and University Elective cells are not modelled at all.`,
  );
  out.push(
    `- **Late starts.** ${pc(o.share_all_cells_starting_at_or_after_15_45)} of our cells start at/after 15:45 versus ${pc(admin.share_all_cells_starting_at_or_after_15_45)} in the grids (${diff(o.share_all_cells_starting_at_or_after_15_45, admin.share_all_cells_starting_at_or_after_15_45, 0.005)}). Our rule penalises 15:45+ hard but still uses it when a teacher or lab room has no other slot; the admin avoids the late columns almost completely in Semester 3.`,
  );
  const ours08 = (o.theory_slot_start_histogram['08:30'] ?? 0) / Math.max(1, o.theory_slots);
  const adm08 = (admin.theory_slot_start_histogram['08:30'] ?? 0) / Math.max(1, admin.theory_slots);
  const tod =
    ours08 < adm08 - 0.02
      ? 'We rank 08:30-10:30 starts below the 10:45-15:30 core window, and a freshly started day tends to begin at 09:30 or 10:45 because the idle-gap rule only counts gaps between two placed sessions, so the first column is used less often than the admin does.'
      : ours08 > adm08 + 0.02
        ? 'Our early starts come from days that are filled from the morning because the run, idle-gap and teacher-load rules push sessions towards contiguous mornings.'
        : 'The early-morning share is close to the hand-made one.';
  out.push(`- **Time of day.** ${pc(ours08)} of our theory slots start at 08:30 versus ${pc(adm08)} in the grids. ${tod}`);
  out.push(
    `- **Same subject twice a day.** Ours: ${o.subject_spread.same_day_repeat_back_to_back} back to back and ${o.subject_spread.same_day_repeat_split} split (the rule forbids a repeat unless the weekly count exceeds the working days); hand-made: ${admin.same_day_repeat_back_to_back} and ${admin.same_day_repeat_split}, mostly the common 2-slot blocks and CNM/SCHIE, which this test timetable does not model. Subjects with all their slots on different days: ${o.subject_spread.subject_slots_all_on_different_days} of ${o.subject_spread.subject_pairs_with_2plus_slots} (ours) versus ${admin.subject_slots_all_on_different_days} (hand-made, different denominator).`,
  );
  out.push(
    `- **Lab rotation.** ${o.lab_rotation.exactly_once_each} of ${o.lab_rotation.panels_with_lab_rotation} multi-batch panels have the exact Latin square (hand-made: ${admin.exactly_once_each} of ${admin.panels_with_lab_rotation}); this is by construction, not a result: the block builder generates the rotation first and the placement only chooses days and times. Where two lab subjects of a division share a teacher a round cannot run in parallel and is split (counted in the 1-batch blocks).`,
  );
  const lr = m.rooms.lab_rooms;
  out.push(
    lr.room_hours_with_two_or_more_groups > 0
      ? `- **Lab rooms.** The admin keeps a fixed room (or two) per lab subject; here the server picks the fullest lab room that still fits (contract 8.7), so ${lr.used} of ${lr.in_pool} lab rooms are used, ${lr.room_hours_with_two_or_more_groups} room-hours hold two or more batch groups and the peak shared load is ${lr.peak_shared_students} students. With \`--lab-rooms=affinity\` the rooms follow lab_rooms.json where they are known.`
      : `- **Lab rooms.** No lab room hosts two groups at once in this run (${lr.used} of ${lr.in_pool} lab rooms used, peak load ${lr.peak_shared_students}): either the server does not share lab rooms by capacity or the lab pool was large enough without packing. The admin's grids put 2-3 batch groups in one big lab in 140 of 213 occupied lab slots.`,
  );
  const dd = m.division_days;
  out.push(
    `- **Runs and gaps.** ${dd.days_with_run_over_3h} of ${dd.with_teaching} division-days exceed 3 consecutive teaching hours and ${dd.days_with_idle_gap} have an idle gap (${dd.total_idle_hours} idle hours in total). ${m.teachers.teacher_days_with_run_over_3h} of ${m.teachers.teacher_days_with_teaching} teacher-days exceed 3 consecutive hours. The grids' own run/gap figures were not extracted into pattern_stats.json, so there is no hand-made number to compare with.`,
  );
  out.push(
    `- **Clashes.** The generated timetable has ${m.integrity.violations} integrity violations by construction (the server refuses them); the hand-made grids contain 7 teacher double-bookings and 1 classroom double-booking (REPORT.md), some of them intended combined lectures that hard clash rules cannot reproduce.`,
  );
  out.push('- **Honest limits.** One greedy run with a fixed seed is a sample, not an optimum: the penalty weights are my own judgement of the admin\'s habits and were tuned only against the offline simulation. A different seed changes details, not the structure. No claim is made that this timetable is better than the hand-made one, only that it is clash-free and follows the stated rules.');
  return out.join('\n');
}

/**
 * renderReport({metrics, run, patternStats, title, source}) -> markdown string
 * run = autoplace_run.json content (optional): {args, stats, rejections, unplaced, elapsed_ms}
 */
export function renderReport({ metrics: m, run = null, patternStats = null, title = 'Real-data test timetable: run report', source = '', runNote = '' }) {
  const L = [];
  const p = m.placement;
  L.push(`# ${title}`, '');
  if (source) L.push(`_${source}_`, '');
  L.push(`Term: ${m.generated_from.term ?? '?'} (version ${m.generated_from.version_id ?? '?'}, rev ${m.generated_from.rev ?? '?'}).`, '');
  if (runNote) L.push(`Run log used: ${runNote}`, '');
  L.push('## 1. Headline', '');
  L.push(
    table(['item', 'value'], [
      ['sessions required', p.total],
      ['placed', `${p.placed} (${p.placed_pct}%)`],
      ['unplaced', `${p.unplaced} (theory ${p.unplaced_by_kind.theory}, lab ${p.unplaced_by_kind.lab})`],
      ['unplaced by reason', list(p.unplaced_by_reason)],
      ['integrity (recomputed from the snapshot)', m.integrity.ok ? `OK, ${m.integrity.checked.placed} placed sessions, ${m.integrity.checked.overlapping_pairs} overlapping pairs inspected, 0 violations` : `FAILED: ${m.integrity.violations} violation(s)`],
      ['rejections by the server', m.rejections_total ? `${m.rejections_total} (${list(m.rejections_by_code)})` : '0 (or no run log)'],
      ...(run ? [['requests sent / resyncs', `${run.stats.requests} / ${run.stats.resyncs}`], ['wall time', `${Math.round((run.elapsed_ms ?? 0) / 1000)} s`], ['lab rooms mode', run.args?.lab_rooms ?? '?'], ['seed', run.args?.seed ?? '?']] : []),
    ]),
    '',
  );
  if (!m.integrity.ok) {
    L.push('**Integrity violations (first 20):**', '', ...m.integrity.first_violations.map((v) => `- ${v.type}: ${v.text}`), '');
  }

  L.push('## 2. Unplaced sessions', '');
  if (!m.unplaced_sessions.length) L.push('None: every required session is placed.', '');
  else {
    L.push(
      table(['division', 'subject', 'batch', 'kind', 'teachers', 'reason code', 'reason'], m.unplaced_sessions.map((u) => [u.division, u.subject, u.batch ?? '', u.kind, u.teachers.join('+'), u.reason_code, u.reason])),
      '',
    );
    const byDiv = {};
    const byTeacher = {};
    for (const u of m.unplaced_sessions) {
      byDiv[u.division] = (byDiv[u.division] || 0) + 1;
      for (const t of u.teachers) byTeacher[t] = (byTeacher[t] || 0) + 1;
    }
    L.push(`Divisions affected: ${list(byDiv)}`, '', `Teachers affected: ${list(byTeacher)}`, '');
  }

  L.push('## 3. Server refusals during the run', '');
  if (!run) L.push('No autoplace run log was found (run autoplace.mjs first, or pass --run-log).', '');
  else {
    const rej = run.rejections || [];
    L.push(`${rej.length} request(s) were refused (${list(run.stats.rejected)}). \`model_mismatches\` = ${run.stats.model_mismatches}: refusals the in-memory model had not predicted. Pre-8.7 fallback triggered: ${run.stats.shared_labs_disabled ? 'yes' : 'no'}. Affinity fallbacks to auto: ${run.stats.affinity_fallbacks}.`, '');
    if (rej.length) L.push(table(['sessions', 'slot', 'status', 'code', 'message'], rej.slice(0, 40).map((r) => [r.sessions.join(' ; ').slice(0, 120), `${r.day} ${r.start}`, r.status, r.code, (r.message || '').slice(0, 140)])), '', rej.length > 40 ? `... and ${rej.length - 40} more in autoplace_run.json` : '', '');
  }

  L.push('## 4. Quality metrics', '');
  const dd = m.division_days;
  L.push(
    table(['metric', 'value'], [
      ['division-days with teaching', dd.with_teaching],
      ['average teaching hours in a teaching day', dd.avg_hours_in_a_teaching_day],
      ['max teaching hours in a day (any division)', dd.max_hours_in_a_day],
      ['division-days over 6 teaching hours', dd.days_over_6_teaching_hours],
      ['longest consecutive run per division-day (hours: count)', list(dd.longest_run_hours_histogram)],
      ['division-days with a run over 3 h', dd.days_with_run_over_3h],
      ['division-days with an idle gap', `${dd.days_with_idle_gap} (${dd.total_idle_hours} h in total, ${dd.avg_idle_hours_per_division_day} h per division-day)`],
      ['batch-days with more than one lab session', m.lab_rules.batch_days_with_more_than_one_lab_session],
      ['batch-days with two different lab subjects', m.lab_rules.batch_days_with_two_different_lab_subjects],
      ['same subject twice a day (back to back / split)', `${m.combined.subject_spread.same_day_repeat_back_to_back} / ${m.combined.subject_spread.same_day_repeat_split}`],
      ['share of cells at/after 15:45 (theory / lab / all)', `${pc(m.combined.share_theory_slots_starting_at_or_after_15_45)} / ${pc(m.combined.share_lab_blocks_starting_at_or_after_15_45)} / ${pc(m.combined.share_all_cells_starting_at_or_after_15_45)}`],
      ['teachers teaching', m.teachers.count_teaching],
      ['average weekly hours per teacher', m.teachers.avg_weekly_hours],
      ['average daily range (max - min hours) per teacher', m.teachers.avg_daily_range_h],
      ['max hours in a day (any teacher)', m.teachers.max_daily_hours_any_teacher],
      ['teacher-days with a run over 3 h', `${m.teachers.teacher_days_with_run_over_3h} of ${m.teachers.teacher_days_with_teaching}`],
      ['teacher longest run (hours: teacher-days)', list(m.teachers.longest_run_hours_histogram)],
    ]),
    '',
  );
  const rc = m.rooms.classrooms;
  const rl = m.rooms.lab_rooms;
  L.push(
    '### Rooms',
    '',
    table(['item', 'value'], [
      ['teachable hours per room per week', m.rooms.teachable_hours_per_week_per_room],
      ['classrooms in pool / used', `${rc.in_pool} / ${rc.used}`],
      ['classroom hours total / avg per used room / max', `${rc.total_hours} / ${rc.avg_hours_per_used_room} / ${rc.max_hours_in_a_room}`],
      ['theory sessions in the division home room', rc.home_room_share === null ? '-' : `${rc.theory_sessions_in_division_home_room} of ${rc.theory_sessions_with_a_home_room} (${pc(rc.home_room_share)})`],
      ['lab rooms in pool / used', `${rl.in_pool} / ${rl.used}`],
      ['lab session hours', rl.session_hours],
      ['lab room-hours with 2+ / 3+ batch groups', `${rl.room_hours_with_two_or_more_groups} / ${rl.room_hours_with_three_or_more_groups}`],
      ['peak shared students in one lab room', rl.peak_shared_students],
      ['lab rooms over capacity', rl.rooms_over_capacity.length ? rl.rooms_over_capacity.join(', ') : 'none'],
    ]),
    '',
    '#### Lab rooms (hours, peak load)',
    '',
    table(['room', 'capacity', 'session hours', 'room-hours shared', 'peak students'], rl.per_room.map((r) => [r.name, r.capacity ?? '?', r.hours, r.shared_hours, r.peak_students])),
    '',
    '#### Busiest teachers',
    '',
    table(['teacher', 'weekly h', 'max day h', 'min day h', 'avg day h', 'longest run h'], m.teachers.top_loaded.map((t) => [`${t.faculty} ${t.name}`, t.weekly_hours, t.max_day_h, t.min_day_h, t.avg_day_h, t.longest_run_h])),
    '',
  );

  L.push('## 5. Per division', '');
  const days = Object.keys(m.per_division[0]?.hours_per_day ?? {});
  L.push(
    table(['division', 'placed/total', ...days.map((d) => `h ${d}`), 'longest run h', 'idle gap days', 'idle h'], m.per_division.map((r) => [r.division, `${r.placed}/${r.sessions}`, ...days.map((d) => r.hours_per_day[d]), r.longest_run_h, r.idle_gap_days, r.idle_hours])),
    '',
  );

  if (patternStats) {
    const admin = combinePatternStats(patternStats);
    L.push('## 6. Comparison with the hand-made grids', '');
    L.push('Source of the right-hand column: `fixtures/real/pattern_stats.json` (statistics of the admin\'s grids, Semester 3 + 5 summed). It was used only now, after the timetable was built, never to choose a placement.', '');
    L.push(table(['metric', 'generated', 'hand-made', 'note'], comparisonRows(m, admin).map((r) => [r.metric, r.ours, r.admin, r.note])), '');
    L.push('### Theory slot start times', '', histCompare(m.combined.theory_slot_start_histogram, admin.theory_slot_start_histogram), '');
    L.push('### Lab block start times', '', histCompare(m.combined.lab_block_start_histogram, admin.lab_block_start_histogram), '');
    L.push('### Parallel batches per lab block', '', histCompare(m.combined.lab_block_parallel_batch_entries_histogram, admin.lab_block_parallel_batch_entries_histogram), '');
    L.push('### Discussion', '', discussion(m, admin), '');
  }
  return L.join('\n');
}
