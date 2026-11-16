#!/usr/bin/env node
// Places the generated sessions of the REAL-TEST term through POST /planner/versions/:id/ops.
//   node tests/planner/real/autoplace.mjs [--term <id>] [--lab-rooms=auto|affinity] [--seed N] [--fresh] [--shared-labs=on|off]
//
// The strategy (see PLACEMENT_STRATEGY.md) lives in lib/{rotation,rank,engine}.mjs; this file only does the I/O:
// load the snapshot, hand the engine a `send` and a `refetch`, write out/autoplace_run.json and print a summary.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApi, describeRateInfo } from './lib/api.mjs';
import { openAdminSession } from './lib/session.mjs';
import { readJson, HERE } from './lib/fixtures.mjs';
import { parseArgs } from './lib/args.mjs';
import { findTerm } from './lib/term.mjs';
import { autoplace, FatalApiError } from './lib/engine.mjs';
import { makeAffinityLookup } from './lib/labrooms.mjs';
import { checkIntegrity } from './lib/integrity.mjs';

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('usage: node tests/planner/real/autoplace.mjs [--term ID] [--lab-rooms=auto|affinity] [--seed N] [--fresh] [--shared-labs=on|off] [--base-url URL]');
  process.exit(0);
}
if (args['base-url']) process.env.BASE_URL = args['base-url'];
const labRooms = String(args['lab-rooms'] ?? 'auto');
if (!['auto', 'affinity'].includes(labRooms)) {
  console.error('--lab-rooms must be auto or affinity');
  process.exit(2);
}
const seed = Number.isFinite(Number(args.seed)) ? Number(args.seed) : 1;
const sharedLabs = String(args['shared-labs'] ?? 'on') !== 'off';

async function main() {
  const session = await openAdminSession();
  const api = createApi({ baseUrl: session.baseUrl, cookie: session.cookie, onWait: (s, what) => console.log(`  rate limited on ${what}; waiting ${s}s`) });
  try {
    const list = await api.get('/terms');
    if (list.status !== 200) throw new Error(`GET /planner/terms -> ${list.status} ${list.body?.error ?? ''}`);
    console.log(describeRateInfo(api.rateInfo));
    const term = findTerm(list.body.terms, args.term && args.term !== true ? String(args.term) : null);
    if (!term) throw new Error(args.term ? `no term with id ${args.term}` : 'no REAL-TEST term found: run seed_real_term.mjs first');
    const versionId = term.draft_version_id ?? (await api.get(`/terms/${term.id}`)).body?.draft_version_id;
    if (!versionId) throw new Error('the term has no draft version');
    const snapUrl = `/versions/${versionId}/snapshot`;
    const fetchSnap = async () => {
      const r = await api.get(snapUrl);
      if (r.status !== 200) throw new Error(`GET snapshot -> ${r.status} ${r.body?.error ?? ''}`);
      return r.body;
    };
    let snapshot = await fetchSnap();
    if (!snapshot.sessions.length) throw new Error('the draft has no sessions: run seed_real_term.mjs (sync-sessions) first');
    console.log(`term ${term.id}  draft ${versionId}  rev ${snapshot.rev}  sessions ${snapshot.sessions.length}  rooms ${snapshot.rooms.length}  seed ${seed}  lab-rooms ${labRooms}`);

    if (args.fresh) {
      const placed = snapshot.sessions.filter((s) => s.weekday !== null && !s.locked);
      console.log(`--fresh: unplacing ${placed.length} placed session(s)`);
      for (let i = 0; i < placed.length; i += 50) {
        const r = await api.post(`/versions/${versionId}/ops`, { client_id: `real-fresh-${seed}`, ops: placed.slice(i, i + 50).map((s) => ({ op: 'unplace', session_id: s.id })) });
        if (r.status !== 200) throw new Error(`unplace -> ${r.status} ${r.body?.code ?? ''} ${r.body?.error ?? ''}`);
      }
      snapshot = await fetchSnap();
    }

    let affinity = null;
    if (labRooms === 'affinity') {
      affinity = makeAffinityLookup(readJson('lab_rooms.json'), snapshot.rooms);
    }

    const t0 = Date.now();
    const runArgs = { term_id: term.id, version_id: versionId, lab_rooms: labRooms, seed, shared_labs_initial: sharedLabs, fresh: !!args.fresh };
    // mark the run log as "in progress" right away so that analyze never mixes in the log of an earlier run
    mkdirSync(join(HERE, 'out'), { recursive: true });
    const logFile = join(HERE, 'out', 'autoplace_run.json');
    writeFileSync(logFile, JSON.stringify({ args: runArgs, started_at: new Date().toISOString(), incomplete: true }, null, 2));
    let result;
    try {
      result = await autoplace({
      snapshot,
      send: (ops, clientId) => api.post(`/versions/${versionId}/ops`, { client_id: clientId, ops }).then((r) => ({ status: r.status, body: r.body })),
      refetch: fetchSnap,
      options: { labRooms, seed, roomsFor: affinity?.roomsFor ?? null, sharedLabs, clientId: `real-autoplace-${seed}` },
      log: (e) => {
        if (e.type === 'division') console.log(`[${e.phase}] ${e.division}: ${e.placed}/${e.total} placed${e.blocks ? ` (${e.blocks} blocks)` : ''}`);
        else if (e.type === 'resync') console.log(`  model resynced from a fresh snapshot (${e.why}, #${e.resyncs})`);
        else if (e.type === 'note') console.log(`  note: ${e.message}`);
      },
      });
    } catch (e) {
      if (e instanceof FatalApiError) {
        const partial = e.partial ?? { stats: {}, rejections: [] };
        writeFileSync(
          logFile,
          JSON.stringify({ args: runArgs, finished_at: new Date().toISOString(), incomplete: true, fatal: { status: e.res?.status ?? null, code: e.res?.body?.code ?? null, message: e.message }, stats: { ...partial.stats, http_requests_total: api.count }, rejections: partial.rejections, unplaced: [] }, null, 2),
        );
        console.error(`run aborted after ${partial.stats?.requests ?? '?'} ops requests (${partial.stats?.placed_now ?? 0} sessions placed in this run); partial log written to out/autoplace_run.json`);
      }
      throw e;
    }
    const elapsed = Date.now() - t0;

    const finalSnap = await fetchSnap();
    const integ = checkIntegrity(finalSnap);
    const placedCount = finalSnap.sessions.filter((s) => s.weekday !== null).length;
    const out = {
      args: runArgs,
      finished_at: new Date().toISOString(),
      elapsed_ms: elapsed,
      final_rev: finalSnap.rev,
      stats: { ...result.stats, http_requests_total: api.count, rate_limit_wait_seconds: api.waited_seconds },
      affinity: affinity ? { codes_total: affinity.stats.codes_total, codes_mapped: affinity.stats.codes_mapped, unmapped_codes: [...affinity.stats.unmapped_codes].sort() } : null,
      placed: placedCount,
      total: finalSnap.sessions.length,
      integrity_ok: integ.ok,
      rejections: result.rejections,
      unplaced: result.unplaced.map(({ day_names, ...u }) => u),
    };
    writeFileSync(logFile, JSON.stringify(out, null, 2));

    console.log('\n=== summary ===');
    console.log(`placed ${placedCount}/${finalSnap.sessions.length}   unplaced ${result.unplaced.length}   rev ${finalSnap.rev}   ${Math.round(elapsed / 1000)} s`);
    console.log(`requests: ${result.stats.requests} ops requests (${result.stats.ok_requests} ok), ${api.count} HTTP calls incl. snapshots; rate-limit waits ${api.waited_seconds}s`);
    console.log(`server refusals: ${JSON.stringify(result.stats.rejected)}   model mismatches ${result.stats.model_mismatches}   resyncs ${result.stats.resyncs}`);
    if (result.stats.shared_labs_disabled) console.log('note: the server does not share lab rooms by capacity (pre-8.7); the model switched to exclusive labs');
    if (labRooms === 'affinity') console.log(`affinity: ${result.stats.affinity_fallbacks} block(s) fell back to auto rooms; ${result.stats.affinity_unmapped_sessions} lab session(s) had no mapped room`);
    console.log(`integrity (recomputed from the final snapshot): ${integ.ok ? 'OK' : `${integ.violations.length} VIOLATION(S)`}`);
    const byCode = {};
    for (const u of result.unplaced) byCode[u.code] = (byCode[u.code] || 0) + 1;
    if (result.unplaced.length) {
      console.log(`unplaced by reason: ${JSON.stringify(byCode)}`);
      for (const u of result.unplaced.slice(0, 20)) console.log(`  ${u.key}: ${u.code} - ${u.text}`);
      if (result.unplaced.length > 20) console.log(`  ... ${result.unplaced.length - 20} more in out/autoplace_run.json`);
    }
    console.log('run log written to tests/planner/real/out/autoplace_run.json. Next: node tests/planner/real/analyze.mjs');
    if (!integ.ok) process.exitCode = 3;
  } finally {
    await session.release();
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e instanceof FatalApiError ? `FATAL: ${e.message}` : `ERROR: ${e.message}`);
    process.exit(1);
  });
