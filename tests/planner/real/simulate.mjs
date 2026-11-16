#!/usr/bin/env node
// OFFLINE dry run: builds the real world from the four CSVs, runs the autoplace engine against an in-process fake
// server (no HTTP, no database, no Redis) and writes out/sim_report.md + out/sim_metrics.json. It exists to check the
// strategy and the wiring before a live run; it does NOT touch real_run_report.md.
//   node tests/planner/real/simulate.mjs [--seed N] [--lab-rooms=auto|affinity] [--shared-labs=on|off] [--fail-every N]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadImportRows, readJson, HERE } from './lib/fixtures.mjs';
import { buildWorld } from './lib/world.mjs';
import { FakeServer } from './lib/fakeServer.mjs';
import { autoplace } from './lib/engine.mjs';
import { makeAffinityLookup } from './lib/labrooms.mjs';
import { computeMetrics } from './lib/metrics.mjs';
import { renderReport } from './lib/report.mjs';
import { parseArgs } from './lib/args.mjs';

const args = parseArgs(process.argv.slice(2));
const seed = Number.isFinite(Number(args.seed)) ? Number(args.seed) : 1;
const labRooms = String(args['lab-rooms'] ?? 'auto');
const serverShares = String(args['server-shares-labs'] ?? 'on') !== 'off';

const world = buildWorld({ ...loadImportRows(), rooms: readJson('rooms_snapshot.json') });
const fake = new FakeServer(world, { sharedLabs: serverShares, failEvery: Number(args['fail-every'] ?? 0) });
const affinity = labRooms === 'affinity' ? makeAffinityLookup(readJson('lab_rooms.json'), world.rooms) : null;
const t0 = Date.now();
const result = await autoplace({
  snapshot: world,
  send: (ops, clientId) => fake.send({ client_id: clientId, ops }),
  refetch: async () => fake.snapshot(),
  options: { seed, labRooms, roomsFor: affinity?.roomsFor ?? null, sharedLabs: String(args['shared-labs'] ?? 'on') !== 'off' },
  log: (e) => {
    if (e.type === 'division') console.log(`[${e.phase}] ${e.division}: ${e.placed}/${e.total}`);
    else if (e.type === 'note' || e.type === 'resync') console.log(`  ${e.message ?? `resync (${e.why})`}`);
  },
});
const elapsed = Date.now() - t0;
const snap = fake.snapshot();
const run = { args: { lab_rooms: labRooms, seed }, elapsed_ms: elapsed, stats: result.stats, rejections: result.rejections, unplaced: result.unplaced };
const metrics = computeMetrics(snap, { unplaced: result.unplaced, rejections: result.rejections });
mkdirSync(join(HERE, 'out'), { recursive: true });
writeFileSync(join(HERE, 'out', 'sim_metrics.json'), JSON.stringify(metrics, null, 2));
writeFileSync(join(HERE, 'out', 'sim_report.md'), renderReport({ metrics, run, patternStats: readJson('pattern_stats.json'), title: 'Offline simulation (fake server): run report', source: 'OFFLINE simulation against an in-process fake server, not the real API' }));
console.log(`\nplaced ${metrics.placement.placed}/${metrics.placement.total}, integrity ${metrics.integrity.ok ? 'OK' : 'FAILED'}, ${result.stats.requests} requests, ${Math.round(elapsed / 1000)} s`);
console.log('wrote tests/planner/real/out/sim_report.md and sim_metrics.json');
