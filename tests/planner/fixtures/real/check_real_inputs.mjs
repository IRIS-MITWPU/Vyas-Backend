// Offline validation of the four real-data CSVs with the planner's own domain code (no DB, no server).
//   node tests/planner/fixtures/real/check_real_inputs.mjs [--quiet]
// Mirrors services/planner/importer.js#buildCtx: faculty -> subjects -> divisions -> offerings, each later entity
// validated against a ctx that contains the (validated) earlier ones. Rooms come from rooms_snapshot.json
// (written read-only by fetch_rooms.mjs); keys are "<building> / <room>" lowercased + whitespace-collapsed.
// Exit code 1 when any row is an error or a file exceeds 2000 rows.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateImportRows, groupImportRows, DEFAULT_TERM_SETTINGS } from '../../../../services/planner/domain/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_ROWS = 2000;
const lc = (s) => String(s ?? '').trim().toLowerCase();
const collapse = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** RFC4180-ish CSV parser: quoted fields, "" escapes, commas and newlines inside quotes. Returns array of objects keyed by header. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((c) => c !== ''));
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const read = (name) => {
  const rows = parseCsv(readFileSync(path.join(here, name), 'utf8'));
  return rows;
};

// ---- self-test of the CSV parser (quoted commas / quotes / newlines)
{
  const t = parseCsv('a,b\n"x, y","he said ""hi"""\n"multi\nline",z\n');
  if (t[0].a !== 'x, y' || t[0].b !== 'he said "hi"' || t[1].a !== 'multi\nline' || t[1].b !== 'z') throw new Error('CSV parser self-test failed');
}

const rooms = {};
for (const r of JSON.parse(readFileSync(path.join(here, 'rooms_snapshot.json'), 'utf8'))) {
  const k = `${collapse(r.building)} / ${collapse(r.room)}`;
  rooms[k] = rooms[k] ? [...[].concat(rooms[k]), { id: `room:${k}` }] : { id: `room:${k}` };
}

const term = { id: 'term:real', ...DEFAULT_TERM_SETTINGS };
const ctx = { term, faculty: {}, subjects: {}, divisions: {}, rooms, offerings: {} };
const quiet = process.argv.includes('--quiet');
let totalErrors = 0;
const summary = [];

function run(entity, file) {
  const rows = read(file);
  if (rows.length > MAX_ROWS) { console.error(`${file}: ${rows.length} rows exceeds ${MAX_ROWS}`); totalErrors += 1; }
  const results = validateImportRows(entity, rows, ctx);
  const errs = results.filter((r) => r.status === 'error');
  const warns = results.flatMap((r) => r.warnings.map((w) => ({ row: r.row, key: r.key, ...w })));
  totalErrors += errs.length;
  summary.push({ entity, file, rows: rows.length, create: results.filter((r) => r.status === 'create').length, update: results.filter((r) => r.status === 'update').length, errors: errs.length, warnings: warns.length });
  for (const r of errs) for (const e of r.errors) console.error(`ERROR ${file} row ${r.row} [${e.field}] ${e.message}  (${r.key})`);
  if (!quiet) {
    const byMsg = new Map();
    for (const w of warns) {
      const m = `[${w.field}] ${w.message.replace(/"[^"]*"/g, '"…"')}`;
      byMsg.set(m, (byMsg.get(m) ?? 0) + 1);
    }
    for (const [m, n] of byMsg) console.log(`WARNING ${file} x${n} ${m}`);
  }
  return results;
}

// faculty -> ctx.faculty
const fRes = run('faculty', 'faculty.csv');
for (const r of groupImportRows('faculty', fRes)) ctx.faculty[lc(r.short_code)] = { id: `faculty:${lc(r.short_code)}` };

// subjects -> ctx.subjects
const sRes = run('subjects', 'subjects.csv');
for (const r of groupImportRows('subjects', sRes)) ctx.subjects[lc(r.code)] = { id: `subject:${lc(r.code)}`, kind: r.kind };

// divisions -> ctx.divisions (with batch names, like the importer's non-whole batch list)
const dRes = run('divisions', 'divisions.csv');
for (const g of groupImportRows('divisions', dRes)) {
  ctx.divisions[`${g.semester}|${lc(g.name)}`] = { id: `division:${g.semester}|${lc(g.name)}`, batches: g.batches.map((b) => b.name) };
}

// offerings
const oRes = run('offerings', 'offerings.csv');

console.log('\nSummary');
console.table(summary);
// every faculty code must be used (informational) and every subject must be used
const usedFaculty = new Set(), usedSubjects = new Set();
for (const r of oRes) if (r.normalized) { r.normalized.faculty.forEach((f) => usedFaculty.add(lc(f.short_code))); usedSubjects.add(lc(r.normalized.subject_code)); }
const unusedF = Object.keys(ctx.faculty).filter((k) => !usedFaculty.has(k));
const unusedS = Object.keys(ctx.subjects).filter((k) => !usedSubjects.has(k));
console.log(`faculty rows never used in offerings: ${unusedF.length}${unusedF.length ? ' (' + unusedF.join(', ') + ')' : ''}`);
console.log(`subject rows never used in offerings: ${unusedS.length}${unusedS.length ? ' (' + unusedS.join(', ') + ')' : ''}`);
console.log(totalErrors === 0 ? 'RESULT: 0 error rows' : `RESULT: ${totalErrors} error(s)`);
process.exit(totalErrors === 0 ? 0 : 1);
