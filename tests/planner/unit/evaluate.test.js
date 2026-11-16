import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAll, evaluateRule } from '../../../services/planner/engine/evaluate.js';
import { RULES } from '../../../services/planner/engine/rules/index.js';
import { DEFAULT_RULES, RULE_KEYS } from '../../../services/planner/domain/index.js';
import { mini, put, theoryWorld, T } from './ruleKit.js';
import { loadImportRows, readJson, HAS_REAL, SKIP_REAL } from '../real/lib/fixtures.mjs';
import { buildWorld } from '../real/lib/world.mjs';

/** DEFAULT_RULES as mutable rows with overrides: over = {key: {enabled?, severity?, params?}}. */
function rules(over = {}) {
  return DEFAULT_RULES.map((r) => ({ ...r, params: { ...r.params }, ...(over[r.rule_key] || {}) }));
}
const clean = () => {
  const w = theoryWorld({ weekly: 4 });
  for (let i = 0; i < 4; i++) put(w, 'CSE-A', 'DS', 'ALL', i + 1, i, T.s1045, 'C1');
  return w;
};

test('the registry has a check for every one of the 23 rule keys', () => {
  assert.deepEqual(Object.keys(RULES).sort(), [...RULE_KEYS].sort());
  for (const [k, r] of Object.entries(RULES)) {
    assert.equal(r.key, k);
    assert.equal(typeof r.check, 'function');
  }
});

test('a clean timetable: no issues, publishable, zero counts, every division listed', () => {
  const w = clean();
  const r = evaluateAll(w, rules());
  assert.deepEqual(r.issues, []);
  assert.equal(r.publishable, true);
  assert.deepEqual(r.counts, { blocking: 0, hard: 0, soft: 0 });
  assert.deepEqual(r.by_division, { [w.divisions[0].id]: { hard: 0, soft: 0 } });
  assert.equal('rev' in r, false, 'rev is added by the route, not here');
});

test('publishable: a hard issue (unplaced session) -> false; soft only -> true', () => {
  const w = clean();
  w.sessions[3].weekday = null; w.sessions[3].start_min = null; w.sessions[3].end_min = null; w.sessions[3].room_id = null;
  const r = evaluateAll(w, rules());
  assert.equal(r.counts.hard, 1);
  assert.equal(r.issues[0].rule_key, 'all_placed');
  assert.equal(r.publishable, false);
  assert.deepEqual(r.by_division[w.divisions[0].id], { hard: 1, soft: 0 });

  const soft = clean();
  put(soft, 'CSE-A', 'DS', 'ALL', 1, 0, T.s1545, 'C1'); // 15:45: only time_of_day (soft) complains
  const s = evaluateAll(soft, rules());
  assert.deepEqual(s.counts, { blocking: 0, hard: 0, soft: 1 });
  assert.equal(s.publishable, true);
  assert.deepEqual(s.by_division[soft.divisions[0].id], { hard: 0, soft: 1 });
});

test('publishable: a blocking issue (clash) -> false', () => {
  const w = theoryWorld({ weekly: 2 });
  put(w, 'CSE-A', 'DS', 'ALL', 1, 0, T.s1045, 'C1');
  put(w, 'CSE-A', 'DS', 'ALL', 2, 0, T.s1045, 'C2'); // same division and faculty at once
  const r = evaluateAll(w, rules());
  assert.ok(r.counts.blocking >= 2, JSON.stringify(r.counts));
  assert.equal(r.publishable, false);
  assert.ok(r.issues.slice(0, r.counts.blocking).every((i) => i.severity === 'blocking'));
});

test('a disabled rule produces no issue; blocking rules cannot be disabled', () => {
  const w = theoryWorld({ weekly: 2 });
  put(w, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1');
  put(w, 'CSE-A', 'DS', 'ALL', 2, 0, T.s0930, 'C1'); // subject_spread + time_of_day (08:30, 09:30)
  const on = evaluateAll(w, rules());
  assert.ok(on.issues.some((i) => i.rule_key === 'subject_spread'));
  const off = evaluateAll(w, rules({ subject_spread: { enabled: false }, time_of_day: { enabled: false } }));
  assert.equal(off.issues.filter((i) => i.rule_key === 'subject_spread' || i.rule_key === 'time_of_day').length, 0);
  assert.equal(evaluateRule('subject_spread', w, { ...DEFAULT_RULES.find((r) => r.rule_key === 'subject_spread'), enabled: false }).length, 0);

  const clash = theoryWorld({ weekly: 2 });
  put(clash, 'CSE-A', 'DS', 'ALL', 1, 0, T.s1045, 'C1');
  put(clash, 'CSE-A', 'DS', 'ALL', 2, 0, T.s1045, 'C2');
  const r = evaluateAll(clash, rules({ faculty_clash: { enabled: false, severity: 'soft' } }));
  assert.ok(r.issues.some((i) => i.rule_key === 'faculty_clash' && i.severity === 'blocking'));
});

test('switching a rule hard <-> soft changes its issues severity and `publishable`', () => {
  const w = clean();
  w.sessions[3].weekday = null; w.sessions[3].start_min = null; w.sessions[3].end_min = null; w.sessions[3].room_id = null;
  const hard = evaluateAll(w, rules());
  assert.equal(hard.publishable, false);
  const soft = evaluateAll(w, rules({ all_placed: { severity: 'soft' } }));
  assert.equal(soft.publishable, true);
  assert.deepEqual(soft.counts, { blocking: 0, hard: 0, soft: 1 });
  assert.equal(soft.issues[0].severity, 'soft');

  // and the other way: a soft rule made hard blocks publishing
  const sw = theoryWorld({ weekly: 1 });
  put(sw, 'CSE-A', 'DS', 'ALL', 1, 0, T.s1545, 'C1');
  assert.equal(evaluateAll(sw, rules()).publishable, true);
  const asHard = evaluateAll(sw, rules({ time_of_day: { severity: 'hard' } }));
  assert.equal(asHard.publishable, false);
  assert.equal(asHard.issues[0].severity, 'hard');
});

test('missing rule rows fall back to the defaults; no rules argument = defaults', () => {
  const w = theoryWorld({ weekly: 1 });
  put(w, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1');
  const a = evaluateAll(w);
  const b = evaluateAll(w, []);
  const c = evaluateAll(w, rules());
  assert.deepEqual(a, c);
  assert.deepEqual(b, c);
  const onlyOne = evaluateAll(w, [{ rule_key: 'time_of_day', enabled: false, severity: 'soft', weight: 1, params: {} }]);
  assert.equal(onlyOne.issues.length, 0);
});

test('issues are sorted blocking, hard, soft, then division, weekday', () => {
  const w = mini({
    rooms: [{ name: 'C1', cap: 70 }, { name: 'C2', cap: 70 }],
    faculty: ['A', 'B'],
    subjects: [{ code: 'DS', kind: 'theory', weekly: 2 }],
    divisions: [{ name: 'CSE-A', students: 60, sem: 3 }, { name: 'CSE-B', students: 60, sem: 3 }],
    offerings: [{ div: 'CSE-A', code: 'DS', faculty: 'A' }, { div: 'CSE-B', code: 'DS', faculty: 'B' }],
  });
  put(w, 'CSE-B', 'DS', 'ALL', 1, 2, T.s1545, 'C1'); // soft (time_of_day) for B on Wednesday
  put(w, 'CSE-A', 'DS', 'ALL', 1, 3, T.s1545, 'C2'); // soft for A on Thursday
  put(w, 'CSE-A', 'DS', 'ALL', 2, 1, T.s1545, 'C2'); // soft for A on Tuesday
  const r = evaluateAll(w, rules());
  const sev = r.issues.map((i) => i.severity);
  assert.deepEqual([...sev], [...sev].sort((x, y) => ['blocking', 'hard', 'soft'].indexOf(x) - ['blocking', 'hard', 'soft'].indexOf(y)));
  const soft = r.issues.filter((i) => i.rule_key === 'time_of_day').map((i) => [i.division_id, i.weekday]);
  assert.deepEqual(soft, [[w.divisions[0].id, 1], [w.divisions[0].id, 3], [w.divisions[1].id, 2]]);
});

test('issue shape and deterministic ids (same input, same ids; independent of session order)', () => {
  const w = theoryWorld({ weekly: 6 });
  for (let i = 0; i < 6; i++) put(w, 'CSE-A', 'DS', 'ALL', i + 1, 0, [T.s0830, T.s0930, T.s1045, T.s1145, T.s1330, T.s1430][i], 'C1');
  const r1 = evaluateAll(w, rules());
  const r2 = evaluateAll(JSON.parse(JSON.stringify(w)), rules());
  assert.deepEqual(r1, r2);
  const rev = JSON.parse(JSON.stringify(w));
  rev.sessions.reverse();
  const r3 = evaluateAll(rev, rules());
  assert.deepEqual(r3.issues.map((i) => i.id).sort(), r1.issues.map((i) => i.id).sort());
  assert.ok(r1.issues.length > 3);
  assert.equal(new Set(r1.issues.map((i) => i.id)).size, r1.issues.length, 'ids are unique');
  for (const i of r1.issues) {
    assert.equal(typeof i.id, 'string');
    assert.ok(i.id.startsWith(`${i.rule_key}:`));
    assert.ok(['blocking', 'hard', 'soft'].includes(i.severity));
    assert.ok(i.message.length > 10 && !/ses-\d|fac-\d|div-\d/.test(i.message), `names, not ids: ${i.message}`);
    assert.ok(Array.isArray(i.session_ids) && [...i.session_ids].sort().join() === i.session_ids.join());
    assert.ok(i.division_id === null || typeof i.division_id === 'string');
    assert.ok(i.faculty_id === null || typeof i.faculty_id === 'string');
    assert.ok(i.weekday === null || Number.isInteger(i.weekday));
  }
  const pair = r1.issues.find((i) => i.rule_key === 'faculty_consecutive');
  assert.equal(pair.id, `faculty_consecutive:${pair.session_ids.join(',')}:f:${pair.faculty_id}:w:0`);
});

test('evaluateAll is pure: the snapshot and the rule rows are not modified', () => {
  const w = theoryWorld({ weekly: 6 });
  for (let i = 0; i < 6; i++) put(w, 'CSE-A', 'DS', 'ALL', i + 1, 0, [T.s0830, T.s0930, T.s1045, T.s1145, T.s1330, T.s1430][i], 'C1');
  const r = rules();
  const before = JSON.stringify([w, r]);
  const out = evaluateAll(w, r);
  assert.ok(out.issues.length > 0);
  assert.equal(JSON.stringify([w, r]), before);
});

test('evaluateRule: unknown key gives []; a single rule matches its slice of evaluateAll', () => {
  const w = theoryWorld({ weekly: 2 });
  put(w, 'CSE-A', 'DS', 'ALL', 1, 0, T.s0830, 'C1');
  put(w, 'CSE-A', 'DS', 'ALL', 2, 0, T.s0930, 'C1');
  assert.deepEqual(evaluateRule('nope', w, {}), []);
  const all = evaluateAll(w, rules());
  for (const key of ['subject_spread', 'time_of_day', 'student_idle_gap']) {
    const one = evaluateRule(key, w, DEFAULT_RULES.find((r) => r.rule_key === key));
    assert.deepEqual(one.map((i) => i.id).sort(), all.issues.filter((i) => i.rule_key === key).map((i) => i.id).sort(), key);
  }
});

/** The real-size world (949 sessions) with a synthetic placement spread over the week (clashes allowed, this is a load test). */
function realSizeSnapshot() {
  const world = buildWorld({ ...loadImportRows(), rooms: readJson('rooms_snapshot.json') });
  const starts = [510, 570, 645, 705, 810, 870, 945, 1005];
  const cell = new Map();
  const divIdx = new Map(world.divisions.map((d, i) => [d.id, i]));
  const offDiv = new Map(world.offerings.map((o) => [o.id, o.division_id]));
  const classrooms = world.rooms.filter((r) => !r.is_lab);
  const labs = world.rooms.filter((r) => r.is_lab);
  for (const s of world.sessions) {
    const d = offDiv.get(s.offering_id);
    const c = cell.get(d) ?? 0;
    cell.set(d, c + 1);
    s.weekday = c % 5;
    s.start_min = starts[(Math.floor(c / 5) + divIdx.get(d)) % 8];
    s.end_min = s.start_min + s.duration_min;
    const pool = s.kind === 'lab' ? labs : classrooms;
    s.room_id = pool[(c + divIdx.get(d)) % pool.length].room_id;
  }
  return world;
}

test('performance: a 949-session snapshot evaluates in well under 200 ms (all 23 rules on)', { skip: SKIP_REAL }, (t) => {
  const snap = realSizeSnapshot();
  assert.ok(snap.sessions.length >= 900, `sessions: ${snap.sessions.length}`);
  const rows = rules();
  evaluateAll(snap, rows); // warm up
  const times = [];
  let r;
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now();
    r = evaluateAll(snap, rows);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const median = times[3];
  t.diagnostic(`evaluateAll ${snap.sessions.length} sessions: median ${median.toFixed(1)} ms, max ${times[6].toFixed(1)} ms, ${r.issues.length} issues`);
  assert.ok(median < 200, `median ${median} ms`);
  assert.equal(new Set(r.issues.map((i) => i.id)).size, r.issues.length, 'ids unique at real size');
});
