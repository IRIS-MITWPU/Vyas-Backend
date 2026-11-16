// Lab block construction: Latin-square rotation of lab subjects over a division's batches. Pure.
//
// A "lab block" is a set of lab sessions of ONE division that run at the same time (one session per batch,
// pairwise disjoint teachers). The rotation makes every batch meet every lab subject once per week while
// each parallel block puts the batches on different subjects.
import { cmpText } from './time.mjs';

/**
 * Latin rotation for k batches and L lab subjects. n = max(k, L); in round r batch i gets subject (i + r) mod n;
 * a cell is null when that index is >= L (fewer subjects than batches). Result: n rounds, each an array of k
 * entries (subject index | null). Every batch meets every subject exactly once and no round repeats a subject.
 */
export function latinRounds(k, L) {
  const n = Math.max(k, L);
  const rounds = [];
  if (k <= 0 || L <= 0) return rounds;
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let i = 0; i < k; i++) {
      const s = (i + r) % n;
      row.push(s < L ? s : null);
    }
    if (row.some((c) => c !== null)) rounds.push(row);
  }
  return rounds;
}

/** Lexicographic permutations of [0..n-1], capped. */
function* permutations(n, cap) {
  const a = Array.from({ length: n }, (_, i) => i);
  let count = 0;
  const swap = (i, j) => {
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  };
  // Heap-free lexicographic next-permutation
  while (true) {
    yield [...a];
    if (++count >= cap) return;
    let i = n - 2;
    while (i >= 0 && a[i] >= a[i + 1]) i--;
    if (i < 0) return;
    let j = n - 1;
    while (a[j] <= a[i]) j--;
    swap(i, j);
    for (let l = i + 1, r = n - 1; l < r; l++, r--) swap(l, r);
  }
}

const disjoint = (a, b) => !a.some((x) => b.includes(x));

/**
 * sessions: [{id, batch_id, batch_name, offering_id, subject_code, seq, faculty_ids}] -- the unplaced lab sessions of one
 * division. Returns blocks [{key, session_ids, batch_ids, rotation:boolean}] ordered biggest first.
 *  - units = (offering, seq) pairs, ordered by seq then subject code (so repeats of a subject are far apart);
 *  - rounds from latinRounds(k, L); the unit order is permuted (up to 720 permutations, lexicographic, deterministic)
 *    to find the arrangement where the fewest sessions must leave their round because two parallel sessions share a teacher;
 *  - sessions that cannot stay in their round are packed first-fit into the other blocks (one session per batch, disjoint
 *    teachers) or into new blocks; finally blocks that can run in parallel (no common batch, disjoint teachers) are merged.
 */
export function buildLabBlocks(sessions) {
  if (!sessions.length) return [];
  const batches = [...new Map(sessions.map((s) => [s.batch_id, s.batch_name])).entries()]
    .sort((a, b) => cmpText(a[1], b[1]) || cmpText(a[0], b[0]))
    .map(([id]) => id);
  const unitKey = (s) => `${s.offering_id}#${s.seq}`;
  const unitMeta = new Map();
  for (const s of sessions) if (!unitMeta.has(unitKey(s))) unitMeta.set(unitKey(s), { key: unitKey(s), seq: s.seq, code: s.subject_code });
  const units = [...unitMeta.values()].sort((a, b) => a.seq - b.seq || cmpText(a.code, b.code) || cmpText(a.key, b.key)).map((u) => u.key);
  const cell = new Map(); // `${batch}|${unit}` -> session
  for (const s of sessions) cell.set(`${s.batch_id}|${unitKey(s)}`, s);

  const k = batches.length;
  const L = units.length;
  const rounds = latinRounds(k, L);

  const attempt = (perm) => {
    const kept = [];
    const left = [];
    for (const row of rounds) {
      const block = [];
      const used = [];
      row.forEach((c, i) => {
        if (c === null) return;
        const s = cell.get(`${batches[i]}|${units[perm[c]]}`);
        if (!s) return;
        if (disjoint(used, s.faculty_ids)) {
          block.push(s);
          used.push(...s.faculty_ids);
        } else left.push(s);
      });
      if (block.length) kept.push(block);
    }
    return { kept, left };
  };

  let best = null;
  const cap = L <= 6 ? 720 : 2;
  const gen = L <= 6 ? permutations(L, cap) : [Array.from({ length: L }, (_, i) => i), Array.from({ length: L }, (_, i) => L - 1 - i)];
  for (const perm of gen) {
    const r = attempt(perm);
    if (!best || r.left.length < best.left.length) best = r;
    if (best.left.length === 0) break;
  }

  const blocks = best.kept.map((b) => b.slice());
  const fits = (block, s) =>
    !block.some((x) => x.batch_id === s.batch_id) && block.every((x) => disjoint(x.faculty_ids, s.faculty_ids));
  const orderedLeft = [...best.left].sort((a, b) => a.seq - b.seq || cmpText(a.subject_code, b.subject_code) || cmpText(a.batch_name, b.batch_name));
  // sessions that no rotation round covered (uneven offers) are also "left"
  const covered = new Set(blocks.flat().map((s) => s.id).concat(orderedLeft.map((s) => s.id)));
  for (const s of sessions) if (!covered.has(s.id)) orderedLeft.push(s);
  for (const s of orderedLeft) {
    const target = blocks.find((b) => fits(b, s));
    if (target) target.push(s);
    else blocks.push([s]);
  }
  // merge blocks that can run in parallel
  let changed = true;
  while (changed) {
    changed = false;
    blocks.sort((a, b) => a.length - b.length);
    outer: for (let i = 0; i < blocks.length; i++) {
      for (let j = blocks.length - 1; j > i; j--) {
        const merged = blocks[j].concat(blocks[i]);
        const flat = merged.flatMap((s) => s.faculty_ids);
        if (new Set(merged.map((s) => s.batch_id)).size === merged.length && new Set(flat).size === flat.length) {
          blocks[j] = merged;
          blocks.splice(i, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  const out = blocks.map((b) => {
    const sorted = [...b].sort((x, y) => batches.indexOf(x.batch_id) - batches.indexOf(y.batch_id));
    return {
      key: sorted.map((s) => s.id).join('+'),
      session_ids: sorted.map((s) => s.id),
      batch_ids: sorted.map((s) => s.batch_id),
      sessions: sorted,
    };
  });
  out.sort((a, b) => b.session_ids.length - a.session_ids.length || cmpText(a.sessions[0].subject_code, b.sessions[0].subject_code) || cmpText(a.sessions[0].batch_name, b.sessions[0].batch_name));
  return out;
}
