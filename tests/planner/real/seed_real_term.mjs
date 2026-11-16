#!/usr/bin/env node
// Seeds the REAL-TEST term through the public planner API.
//   cd Vyas-Backend && node tests/planner/real/seed_real_term.mjs [--reset] [--base-url http://localhost:3000]
// Needs a running server (PLANNER_ENABLED=true, RUN_WORKERS=false) and the local database (for the admin session only).
// --reset deletes the existing REAL-TEST term (plain SQL, only when its branch is 'REAL-TEST') and starts over.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApi, describeRateInfo } from './lib/api.mjs';
import { openAdminSession } from './lib/session.mjs';
import { loadImportRows, HERE } from './lib/fixtures.mjs';
import { parseArgs } from './lib/args.mjs';
import { TERM_KEY, findTerm } from './lib/term.mjs';

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('usage: node tests/planner/real/seed_real_term.mjs [--reset] [--base-url URL]\nenv: BASE_URL, PLANNER_COOKIE (skips the DB session)');
  process.exit(0);
}
if (args['base-url']) process.env.BASE_URL = args['base-url'];

const fail = (msg) => {
  console.error(`ERROR: ${msg}`);
  process.exitCode = 1;
};

async function resetTerm(session, term) {
  const pool = session.pool ?? (await import('../../../database/db.js')).default;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const chk = await client.query('SELECT id, branch FROM planner_terms WHERE id = $1 FOR UPDATE', [term.id]);
    if (!chk.rows[0] || chk.rows[0].branch !== TERM_KEY.branch) throw new Error('refusing to delete: the term is not a REAL-TEST term');
    const del = await client.query('DELETE FROM planner_terms WHERE id = $1 AND branch = $2 AND academic_year = $3 AND half = $4', [term.id, TERM_KEY.branch, TERM_KEY.academic_year, TERM_KEY.half]);
    if (del.rowCount !== 1) throw new Error(`expected to delete exactly 1 term, deleted ${del.rowCount}`);
    await client.query('COMMIT');
    console.log(`reset: deleted the old REAL-TEST term ${term.id}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    if (!session.pool) await pool.end();
  }
}

async function main() {
  const session = await openAdminSession();
  const api = createApi({ baseUrl: session.baseUrl, cookie: session.cookie, onWait: (s, what) => console.log(`  rate limited on ${what}; waiting ${s}s`) });
  try {
    // ---- term
    const list = await api.get('/terms');
    if (list.status !== 200) return fail(`GET /planner/terms -> ${list.status} ${list.body?.error ?? ''} (is the server running with PLANNER_ENABLED=true?)`);
    console.log(describeRateInfo(api.rateInfo));
    let term = findTerm(list.body.terms);
    if (term && args.reset) {
      await resetTerm(session, term);
      term = null;
    }
    if (term) console.log(`reusing the existing REAL-TEST term ${term.id} (use --reset to start over)`);
    else {
      const c = await api.post('/terms', { ...TERM_KEY });
      if (c.status !== 201) return fail(`create term -> ${c.status} ${JSON.stringify(c.body)}`);
      term = { ...c.body.term, draft_version_id: c.body.version.id };
      console.log(`created term ${term.id} (${TERM_KEY.academic_year} ${TERM_KEY.half} ${TERM_KEY.branch}), Mon-Fri defaults`);
    }
    const termId = term.id;
    let draftId = term.draft_version_id;
    if (!draftId) draftId = (await api.get(`/terms/${termId}`)).body?.draft_version_id;
    if (!draftId) return fail('the term has no draft version');

    // ---- imports (faculty -> subjects -> divisions -> offerings)
    const input = loadImportRows();
    console.log('NOTE: the faculty import upserts GLOBAL faculty rows by short_code (it can update names of existing faculty).');
    for (const entity of ['faculty', 'subjects', 'divisions', 'offerings']) {
      const r = await api.post(`/terms/${termId}/import/${entity}?dryRun=false`, { rows: input[entity] });
      if (r.status === 422) {
        console.error(`import ${entity}: 422 IMPORT_HAS_ERRORS, nothing applied. Row errors:`);
        const bad = (r.body?.rows ?? []).filter((x) => x.status === 'error');
        for (const x of bad.slice(0, 50)) console.error(`  row ${x.row} (${x.key}): ${x.errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`);
        if (bad.length > 50) console.error(`  ... and ${bad.length - 50} more`);
        return fail(`import of ${entity} aborted`);
      }
      if (r.status !== 200) return fail(`import ${entity} -> ${r.status} ${r.body?.code ?? ''} ${r.body?.error ?? ''}`);
      const s = r.body.summary;
      console.log(`import ${entity}: ${s.total} rows -> create ${s.create}, update ${s.update}, error ${s.error}`);
    }

    // ---- room pool: all active Vyas rooms
    const avail = await api.get('/available-rooms');
    if (avail.status !== 200) return fail(`GET available-rooms -> ${avail.status}`);
    const have = await api.get(`/terms/${termId}/rooms`);
    const inPool = new Set((have.body?.rooms ?? []).map((r) => r.room_id));
    const toAdd = avail.body.rooms.filter((r) => r.is_active !== false && !inPool.has(r.id)).map((r) => r.id);
    if (toAdd.length) {
      const add = await api.post(`/terms/${termId}/rooms`, { room_ids: toAdd });
      if (add.status !== 201) return fail(`add rooms -> ${add.status} ${JSON.stringify(add.body)}`);
    }
    const rooms = (await api.get(`/terms/${termId}/rooms`)).body.rooms;
    console.log(`room pool: ${rooms.length} rooms (${rooms.filter((r) => r.is_lab).length} lab, ${rooms.filter((r) => !r.is_lab).length} other), added ${toAdd.length} now`);

    // ---- readiness
    const ready = await api.get(`/terms/${termId}/readiness`);
    if (ready.status !== 200) return fail(`readiness -> ${ready.status}`);
    const rd = ready.body;
    console.log(`readiness: ready=${rd.ready} errors=${rd.counts.errors} warnings=${rd.counts.warnings} info=${rd.counts.info}`);
    console.log(`  stats: ${JSON.stringify(rd.stats)}`);
    for (const e of rd.errors.slice(0, 15)) console.log(`  ERROR ${e.code}: ${e.message}`);
    const byCode = {};
    for (const w of [...rd.warnings, ...rd.info]) byCode[w.code] = (byCode[w.code] || 0) + 1;
    console.log(`  warnings/info by code: ${JSON.stringify(byCode)}`);

    // ---- sessions
    const sync = await api.post(`/versions/${draftId}/sync-sessions`, {});
    if (sync.status !== 200) return fail(`sync-sessions -> ${sync.status} ${JSON.stringify(sync.body)}`);
    const required = sync.body.by_division.reduce((a, d) => a + d.required, 0);
    console.log(`sync-sessions: added ${sync.body.added}, removed ${sync.body.removed}, kept ${sync.body.kept}, placed_surplus ${sync.body.placed_surplus.length}; ${required} sessions required over ${sync.body.by_division.length} divisions`);

    mkdirSync(join(HERE, 'out'), { recursive: true });
    writeFileSync(join(HERE, 'out', 'seed_result.json'), JSON.stringify({ term_id: termId, draft_version_id: draftId, ready: rd.ready, counts: rd.counts, sessions_required: required, requests: api.count }, null, 2));
    console.log(`done. term_id=${termId} draft_version_id=${draftId} (${api.count} requests). Next: node tests/planner/real/autoplace.mjs`);
  } finally {
    await session.release();
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  });
