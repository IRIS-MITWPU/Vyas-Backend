#!/usr/bin/env node
// Quality analysis of the placed REAL-TEST timetable (read-only API access).
//   node tests/planner/real/analyze.mjs [--term ID] [--run-log out/autoplace_run.json] [--snapshot-file file.json] [--save-snapshot]
// Writes tests/planner/real/real_run_report.md and real_run_metrics.json.
// --snapshot-file analyses a saved snapshot instead of calling the API (no server, no DB).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApi } from './lib/api.mjs';
import { openAdminSession } from './lib/session.mjs';
import { readJson, HERE } from './lib/fixtures.mjs';
import { parseArgs } from './lib/args.mjs';
import { findTerm } from './lib/term.mjs';
import { computeMetrics, combinePatternStats, comparisonRows } from './lib/metrics.mjs';
import { renderReport } from './lib/report.mjs';

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('usage: node tests/planner/real/analyze.mjs [--term ID] [--run-log FILE] [--snapshot-file FILE] [--save-snapshot] [--base-url URL]');
  process.exit(0);
}
if (args['base-url']) process.env.BASE_URL = args['base-url'];

async function loadSnapshot() {
  if (args['snapshot-file'] && args['snapshot-file'] !== true) return { snapshot: JSON.parse(readFileSync(resolve(String(args['snapshot-file'])), 'utf8')), source: `snapshot file ${args['snapshot-file']}` };
  const session = await openAdminSession();
  const api = createApi({ baseUrl: session.baseUrl, cookie: session.cookie, onWait: (s, what) => console.log(`  rate limited on ${what}; waiting ${s}s`) });
  try {
    const list = await api.get('/terms');
    if (list.status !== 200) throw new Error(`GET /planner/terms -> ${list.status} ${list.body?.error ?? ''}`);
    const term = findTerm(list.body.terms, args.term && args.term !== true ? String(args.term) : null);
    if (!term) throw new Error('no REAL-TEST term found: run seed_real_term.mjs first');
    const versionId = term.draft_version_id ?? (await api.get(`/terms/${term.id}`)).body?.draft_version_id;
    const r = await api.get(`/versions/${versionId}/snapshot`);
    if (r.status !== 200) throw new Error(`GET snapshot -> ${r.status} ${r.body?.error ?? ''}`);
    return { snapshot: r.body, source: `live snapshot of term ${term.id}, draft ${versionId}` };
  } finally {
    await session.release();
  }
}

async function main() {
  const { snapshot, source } = await loadSnapshot();
  if (args['save-snapshot']) {
    mkdirSync(join(HERE, 'out'), { recursive: true });
    writeFileSync(join(HERE, 'out', 'last_snapshot.json'), JSON.stringify(snapshot));
    console.log('snapshot saved to tests/planner/real/out/last_snapshot.json');
  }
  const logPath = args['run-log'] && args['run-log'] !== true ? resolve(String(args['run-log'])) : join(HERE, 'out', 'autoplace_run.json');
  let run = existsSync(logPath) ? JSON.parse(readFileSync(logPath, 'utf8')) : null;
  let runNote = 'none (no run log found: unplaced reasons and refusal counts are unknown)';
  if (run) {
    const sameVersion = !run.args?.version_id || !snapshot.version?.id || run.args.version_id === snapshot.version.id;
    if (!sameVersion) {
      console.log(`warning: the run log ${logPath} belongs to version ${run.args.version_id}, this snapshot is version ${snapshot.version.id}: ignoring the log`);
      runNote = `IGNORED ${logPath}: it belongs to another version (${run.args.version_id}); refusal counts and unplaced reasons are unknown`;
      run = null;
    } else if (run.incomplete) {
      console.log(`warning: the run log ${logPath} is incomplete (${run.fatal ? `the run aborted: ${run.fatal.message}` : 'a run is still in progress or crashed'}); its counts are partial`);
      runNote = `${logPath} (INCOMPLETE${run.fatal ? `: aborted with ${run.fatal.status} ${run.fatal.code ?? ''} ${run.fatal.message}` : ''})`;
    } else {
      runNote = `${logPath} (finished ${run.finished_at}, seed ${run.args?.seed}, lab rooms ${run.args?.lab_rooms})`;
    }
  } else console.log(`note: no run log at ${logPath}; unplaced reasons will be unknown`);
  const metrics = computeMetrics(snapshot, { unplaced: run?.unplaced ?? [], rejections: run?.rejections ?? [] });
  const patternStats = readJson('pattern_stats.json');
  metrics.comparison_with_hand_made = comparisonRows(metrics, combinePatternStats(patternStats));
  const runForReport = run ? { ...run, rejections: run.rejections ?? [], stats: { requests: 0, ok_requests: 0, resyncs: 0, rejected: {}, model_mismatches: 0, affinity_fallbacks: 0, shared_labs_disabled: false, ...(run.stats ?? {}) } } : null;
  const md = renderReport({ metrics, run: runForReport, patternStats, source, runNote });
  writeFileSync(join(HERE, 'real_run_metrics.json'), JSON.stringify(metrics, null, 2));
  writeFileSync(join(HERE, 'real_run_report.md'), md);
  const p = metrics.placement;
  console.log(`placed ${p.placed}/${p.total} (${p.placed_pct}%), unplaced ${p.unplaced}, integrity ${metrics.integrity.ok ? 'OK' : `FAILED (${metrics.integrity.violations})`}`);
  console.log('wrote tests/planner/real/real_run_report.md and real_run_metrics.json');
  if (!metrics.integrity.ok) process.exitCode = 3;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  });
