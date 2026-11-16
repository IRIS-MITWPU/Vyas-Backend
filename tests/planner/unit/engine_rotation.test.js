import test from 'node:test';
import assert from 'node:assert/strict';
import { latinRounds, buildLabBlocks } from '../../../services/planner/engine/rotation.js';

// every batch meets every subject exactly once; no round repeats a subject
function assertLatin(k, L) {
  const rounds = latinRounds(k, L);
  for (let b = 0; b < k; b++) {
    const seen = rounds.map((r) => r[b]).filter((c) => c !== null).sort((x, y) => x - y);
    assert.deepEqual(seen, Array.from({ length: L }, (_, i) => i), `batch ${b} (k=${k}, L=${L})`);
  }
  for (const r of rounds) {
    const cells = r.filter((c) => c !== null);
    assert.equal(new Set(cells).size, cells.length, `a round repeats a subject (k=${k}, L=${L})`);
  }
  return rounds;
}

test('rotation: 2 batches / 2 subjects is the 2x2 Latin square', () => {
  assert.deepEqual(latinRounds(2, 2), [[0, 1], [1, 0]]);
});

test('rotation: 3 batches / 3 subjects is a cyclic Latin square', () => {
  assert.deepEqual(latinRounds(3, 3), [[0, 1, 2], [1, 2, 0], [2, 0, 1]]);
});

test('rotation: L != k keeps the Latin properties (L=2/k=3, L=4/k=3, L=3/k=2, L=1/k=2)', () => {
  for (const [k, L] of [[3, 2], [3, 4], [2, 3], [2, 1], [3, 1], [1, 3]]) assertLatin(k, L);
  assert.equal(latinRounds(3, 4).length, 4);
  assert.equal(latinRounds(0, 3).length, 0);
});

const S = (id, batch, off, seq, fac, code = off) => ({ id, batch_id: batch, batch_name: batch, offering_id: off, subject_code: code, seq, faculty_ids: fac });

function checkBlocks(sessions, blocks) {
  const all = blocks.flatMap((b) => b.session_ids);
  assert.equal(all.length, sessions.length);
  assert.equal(new Set(all).size, sessions.length);
  for (const b of blocks) {
    assert.equal(new Set(b.batch_ids).size, b.batch_ids.length, 'one session per batch in a block');
    const fac = b.sessions.flatMap((s) => s.faculty_ids);
    assert.equal(new Set(fac).size, fac.length, 'teachers disjoint inside a block');
  }
}

test('blocks: 3 batches x 3 lab subjects -> 3 blocks, every batch meets every subject once, different subject per batch', () => {
  const sessions = [];
  for (const [bi, b] of ['A1', 'A2', 'A3'].entries()) for (const [oi, o] of ['DSL', 'CNL', 'MMAL'].entries()) sessions.push(S(`${b}-${o}`, b, o, 1, [`T${oi}`]));
  const blocks = buildLabBlocks(sessions);
  checkBlocks(sessions, blocks);
  assert.equal(blocks.length, 3);
  for (const b of blocks) {
    assert.equal(b.sessions.length, 3);
    assert.equal(new Set(b.sessions.map((s) => s.offering_id)).size, 3);
  }
  for (const batch of ['A1', 'A2', 'A3']) assert.deepEqual(blocks.map((b) => b.sessions.find((s) => s.batch_id === batch).offering_id).sort(), ['CNL', 'DSL', 'MMAL']);
});

test('blocks: 2 batches x 2 lab subjects', () => {
  const sessions = [S('1', 'A1', 'X', 1, ['T1']), S('2', 'A1', 'Y', 1, ['T2']), S('3', 'A2', 'X', 1, ['T1']), S('4', 'A2', 'Y', 1, ['T2'])];
  const blocks = buildLabBlocks(sessions);
  checkBlocks(sessions, blocks);
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every((b) => b.sessions.length === 2 && new Set(b.sessions.map((s) => s.offering_id)).size === 2));
});

test('blocks: a teacher on two lab subjects of one division splits the round (never parallel)', () => {
  const sessions = [S('1', 'A1', 'X', 1, ['T']), S('2', 'A1', 'Y', 1, ['T']), S('3', 'A2', 'X', 1, ['T']), S('4', 'A2', 'Y', 1, ['T'])];
  const blocks = buildLabBlocks(sessions);
  checkBlocks(sessions, blocks);
  assert.equal(blocks.length, 4);
});

test('blocks: same teachers on all 3 batches of one subject -> three single blocks', () => {
  const sessions = ['A1', 'A2', 'A3'].map((b, i) => S(`s${i}`, b, 'X', 1, ['T1', 'T2']));
  const blocks = buildLabBlocks(sessions);
  checkBlocks(sessions, blocks);
  assert.equal(blocks.length, 3);
});

test('blocks: per-batch teachers on one subject run in parallel in one block', () => {
  const sessions = [S('1', 'A1', 'X', 1, ['T1']), S('2', 'A2', 'X', 1, ['T2'])];
  const blocks = buildLabBlocks(sessions);
  checkBlocks(sessions, blocks);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].sessions.length, 2);
});

test('blocks: 3 batches with fewer subjects than batches (L=2) are covered, biggest blocks first', () => {
  const sessions = [];
  for (const b of ['A1', 'A2', 'A3']) for (const [oi, o] of ['X', 'Y'].entries()) sessions.push(S(`${b}${o}`, b, o, 1, [`T${oi}`]));
  const blocks = buildLabBlocks(sessions);
  checkBlocks(sessions, blocks);
  assert.ok(blocks.length >= 3);
  assert.ok(blocks[0].sessions.length >= blocks[blocks.length - 1].sessions.length);
});

test('blocks: deterministic', () => {
  const sessions = [];
  for (const b of ['A1', 'A2', 'A3']) for (const [oi, o] of ['X', 'Y', 'Z', 'W'].entries()) sessions.push(S(`${b}${o}`, b, o, 1, [`T${oi}`]));
  assert.deepEqual(buildLabBlocks(sessions).map((b) => b.key), buildLabBlocks([...sessions].reverse()).map((b) => b.key));
});
