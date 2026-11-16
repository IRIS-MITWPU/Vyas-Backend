import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, retryAfterSeconds, describeRateInfo } from './lib/api.mjs';
import { makeAffinityLookup } from './lib/labrooms.mjs';
import { buildWorld, parseFacultyCodes } from './lib/world.mjs';
import { parseArgs } from './lib/args.mjs';
import { findTerm, TERM_KEY } from './lib/term.mjs';
import { loadImportRows, readJson, SKIP_REAL } from './lib/fixtures.mjs';

const H = (o) => new Headers(o);

test('api: retry hints are read from Retry-After, RateLimit-Reset or the combined RateLimit header', () => {
  assert.equal(retryAfterSeconds(H({ 'retry-after': '12' })), 12);
  assert.equal(retryAfterSeconds(H({ 'ratelimit-reset': '45' })), 45);
  assert.equal(retryAfterSeconds(H({ ratelimit: 'limit=3000, remaining=0, reset=30' })), 30);
  assert.equal(retryAfterSeconds(H({ 'retry-after': new Date(Date.now() + 20000).toUTCString() })) >= 19, true);
  assert.equal(retryAfterSeconds(H({})), 60);
  assert.equal(retryAfterSeconds(H({ 'retry-after': '0' })), 1);
});

const res = (status, body, headers = {}) => ({ status, headers: H(headers), text: async () => JSON.stringify(body) });

test('api: a 429 is waited out (using the hint) and retried, the cookie is sent but never reported', async () => {
  const calls = [];
  const waits = [];
  const sleeps = [];
  const api = createApi({
    baseUrl: 'http://x',
    cookie: 'sid=SECRET',
    onWait: (s, what) => waits.push([s, what]),
    sleepImpl: async (ms) => sleeps.push(ms),
    fetchImpl: async (url, init) => {
      calls.push({ url, cookie: init.headers.Cookie, origin: init.headers.Origin });
      return calls.length === 1 ? res(429, { error: 'slow down' }, { 'retry-after': '7' }) : res(200, { success: true });
    },
  });
  const r = await api.get('/terms');
  assert.equal(r.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://x/planner/terms');
  assert.equal(calls[0].cookie, 'sid=SECRET');
  assert.equal(calls[0].origin, 'http://x');
  assert.deepEqual(waits, [[7, 'GET /planner/terms']]);
  assert.equal(sleeps[0] >= 7000, true);
  assert.equal(JSON.stringify(waits).includes('SECRET'), false);
});

test('api: gives up after maxRetries rate-limit waits; HTTP errors are returned, not thrown', async () => {
  const api = createApi({ baseUrl: 'http://x', maxRetries: 2, sleepImpl: async () => {}, fetchImpl: async () => res(429, {}, { 'retry-after': '1' }) });
  await assert.rejects(() => api.get('/terms'), /still rate limited/);
  const api2 = createApi({ baseUrl: 'http://x', fetchImpl: async () => res(409, { success: false, code: 'CLASH' }) });
  const r = await api2.post('/versions/1/ops', { ops: [] });
  assert.deepEqual([r.status, r.body.code], [409, 'CLASH']);
});

test('api: network errors are retried twice and then reported without secrets', async () => {
  let n = 0;
  const api = createApi({ baseUrl: 'http://x', cookie: 'sid=SECRET', sleepImpl: async () => {}, fetchImpl: async () => { n += 1; throw new Error('boom'); } });
  await assert.rejects(() => api.get('/terms'), (e) => /network error/.test(e.message) && !e.message.includes('SECRET'));
  assert.equal(n, 3);
});

test('cli helpers: argv parsing and REAL-TEST term lookup', () => {
  assert.deepEqual(parseArgs(['--term', 'abc', '--lab-rooms=affinity', '--seed', '7', '--fresh']), { _: [], term: 'abc', 'lab-rooms': 'affinity', seed: '7', fresh: true });
  const terms = [{ id: '1', academic_year: '2026-27', half: 'odd', branch: 'CSE' }, { id: '2', ...TERM_KEY }];
  assert.equal(findTerm(terms).id, '2');
  assert.equal(findTerm(terms, '1').id, '1');
  assert.equal(findTerm([]), null);
});

test('world: the CSVs build a consistent snapshot (session expansion follows contract section 2)', { skip: SKIP_REAL }, () => {
  const rows = loadImportRows();
  const w = buildWorld({ ...rows, rooms: readJson('rooms_snapshot.json') });
  assert.equal(w.divisions.length, 40);
  assert.ok(w.divisions.every((d) => d.batches.filter((b) => b.is_whole).length === 1));
  assert.ok(w.sessions.every((s) => s.faculty.length >= 1), 'every session has a teacher');
  const labs = w.sessions.filter((s) => s.kind === 'lab');
  assert.ok(labs.length > 300);
  assert.ok(labs.every((s) => s.duration_min === 120 && s.batch_name !== 'ALL'));
  assert.ok(w.sessions.filter((s) => s.kind === 'theory').every((s) => s.duration_min === 60 && s.batch_name === 'ALL'));
  // expected count recomputed independently
  const subj = new Map(w.subjects.map((s) => [s.id, s]));
  let expected = 0;
  for (const o of w.offerings) {
    const d = w.divisions.find((x) => x.id === o.division_id);
    const per = o.per_batch ? Math.max(1, d.batches.filter((b) => !b.is_whole).length) : 1;
    expected += per * o.effective_weekly_count;
    assert.ok(subj.has(o.subject_id));
  }
  assert.equal(w.sessions.length, expected);
  assert.deepEqual(parseFacultyCodes('AB|CD:assist; EF'), [{ code: 'AB', role: 'lead' }, { code: 'CD', role: 'assist' }, { code: 'EF', role: 'lead' }]);
});

test('labrooms: lab_rooms.json codes are mapped to pool rooms, unmapped rooms give null (auto)', { skip: SKIP_REAL }, () => {
  const w = buildWorld({ ...loadImportRows(), rooms: readJson('rooms_snapshot.json') });
  const lk = makeAffinityLookup(readJson('lab_rooms.json'), w.rooms);
  const info = (subject, division, batch) => ({ subject_code: subject, division_key: `3|${division}`, batch_name: batch });
  const vy028 = w.rooms.find((r) => r.name === 'VY 028').room_id;
  assert.deepEqual(lk.roomsFor(info('S3-CNL', 'CSE-A', 'A1')), [vy028]);
  assert.equal(lk.roomsFor(info('S3-DBMSL', 'AIDS-A', 'A1')), null, 'VY126 is not in the Vyas rooms table');
  assert.equal(lk.roomsFor(info('S3-NOPE', 'CSE-A', 'A1')), null);
  const csfA1 = lk.roomsFor(info('S3-DBMSL', 'CSF-A', 'A1'));
  assert.deepEqual(csfA1, [w.rooms.find((r) => r.name === 'VY 123').room_id]);
  assert.ok(lk.stats.unmapped_codes.has('VY126'));
});

test('api: the limiter headers of the first response are kept for the one-line startup report', async () => {
  const api = createApi({ baseUrl: 'http://x', cookie: 'sid=SECRET', fetchImpl: async () => res(200, {}, { 'ratelimit-limit': '3000', 'ratelimit-remaining': '2999', 'ratelimit-reset': '900', 'ratelimit-policy': '3000;w=900' }) });
  await api.get('/terms');
  const line = describeRateInfo(api.rateInfo);
  assert.match(line, /limit=3000 remaining=2999 reset=900s policy=3000;w=900/);
  assert.equal(line.includes('SECRET'), false);
  assert.equal(describeRateInfo(null), 'rate limit headers: none seen');
});
