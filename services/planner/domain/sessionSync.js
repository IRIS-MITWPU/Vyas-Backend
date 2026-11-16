/**
 * Session expansion and sync planning. Pure, deterministic, no I/O.
 *
 * `state` shape (plain JSON; only the fields below are read):
 *   {
 *     subjects:  [{ id, kind: 'theory'|'lab', weekly_count }],
 *     divisions: [{ id, batches: [{ id, name?, is_whole: boolean }] }],
 *     offerings: [{
 *       id, division_id, subject_id,
 *       weekly_count: number|null,        // override; null => subject.weekly_count
 *       per_batch: boolean,
 *       faculty: [{ batch_id: string|null, faculty_id, role? }]   // batch_id null = every batch
 *     }]
 *   }
 *
 * Expansion rules (contract section 2):
 *  - per_batch=false : `effective` sessions on the whole batch (seq 1..n).
 *  - per_batch=true  : for each non-whole batch, `effective` sessions (seq 1..n);
 *                      a division with no non-whole batch falls back to the whole batch.
 *  - session faculty : offering-faculty rows with batch_id = session batch OR batch_id null,
 *                      de-duplicated (batch-specific rows first, then batch-null rows).
 *
 * planSessionSync is count based: for each (offering, batch) pair
 *   surplus  = existing.length - expected.length  (> 0)  -> unplaced sessions with the highest seq are
 *              deleted first; whatever cannot be deleted because it is placed is reported in placedSurplus.
 *   shortage = expected.length - existing.length  (> 0)  -> the lowest expected seqs not yet present are created.
 * Placed sessions are never in toDeleteIds. `kept` = existing sessions that are not deleted
 * (placed surplus sessions are therefore counted as kept).
 */

/** Effective weekly count of an offering: offering override, else subject default. */
export function effectiveWeeklyCount(offering, subject) {
  const raw = offering && offering.weekly_count !== null && offering.weekly_count !== undefined
    ? offering.weekly_count
    : subject && subject.weekly_count;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The batches an offering's sessions land on (see expansion rules). */
export function targetBatches(offering, division) {
  const batches = division && Array.isArray(division.batches) ? division.batches : [];
  const whole = batches.find((b) => b && b.is_whole) || null;
  if (offering && offering.per_batch) {
    const real = batches.filter((b) => b && !b.is_whole);
    if (real.length) return real;
  }
  return whole ? [whole] : [];
}

/** Faculty ids for a session on `batchId` of an offering (batch-specific first, then batch-null; deduped). */
export function sessionFacultyIds(offering, batchId) {
  const rows = offering && Array.isArray(offering.faculty) ? offering.faculty : [];
  const out = [];
  const seen = new Set();
  const add = (r) => {
    if (r && r.faculty_id !== null && r.faculty_id !== undefined && !seen.has(r.faculty_id)) {
      seen.add(r.faculty_id);
      out.push(r.faculty_id);
    }
  };
  rows.filter((r) => r && r.batch_id === batchId).forEach(add);
  rows.filter((r) => r && (r.batch_id === null || r.batch_id === undefined)).forEach(add);
  return out;
}

/** @returns {{offering_id:string,batch_id:string,seq:number,faculty_ids:string[]}[]} */
export function expectedSessions(state) {
  const s = state || {};
  const subjects = new Map((s.subjects || []).map((x) => [x.id, x]));
  const divisions = new Map((s.divisions || []).map((x) => [x.id, x]));
  const out = [];
  for (const offering of s.offerings || []) {
    if (!offering) continue;
    const subject = subjects.get(offering.subject_id);
    const division = divisions.get(offering.division_id);
    if (!subject || !division) continue;
    const n = effectiveWeeklyCount(offering, subject);
    for (const batch of targetBatches(offering, division)) {
      const faculty_ids = sessionFacultyIds(offering, batch.id);
      for (let seq = 1; seq <= n; seq++) {
        out.push({ offering_id: offering.id, batch_id: batch.id, seq, faculty_ids: [...faculty_ids] });
      }
    }
  }
  return out;
}

const keyOf = (o) => `${o.offering_id}\u0000${o.batch_id}`;

/**
 * @param {{expected: {offering_id,batch_id,seq,faculty_ids}[],
 *          existing: {id,offering_id,batch_id,seq,placed:boolean}[]}} input
 * @returns {{toCreate: object[], toDeleteIds: string[],
 *            placedSurplus: {offering_id,batch_id,count}[], kept: number}}
 */
export function planSessionSync({ expected = [], existing = [] } = {}) {
  const groups = new Map(); // key -> {offering_id,batch_id,expected:[],existing:[]}
  const group = (o) => {
    const k = keyOf(o);
    let g = groups.get(k);
    if (!g) {
      g = { offering_id: o.offering_id, batch_id: o.batch_id, expected: [], existing: [] };
      groups.set(k, g);
    }
    return g;
  };
  for (const e of expected || []) group(e).expected.push(e);
  for (const x of existing || []) group(x).existing.push(x);

  const toCreate = [];
  const toDeleteIds = [];
  const placedSurplus = [];
  let kept = 0;

  for (const g of groups.values()) {
    const have = [...g.existing].sort((a, b) => a.seq - b.seq);
    const want = [...g.expected].sort((a, b) => a.seq - b.seq);
    if (have.length > want.length) {
      let surplus = have.length - want.length;
      let deleted = 0;
      for (let i = have.length - 1; i >= 0 && surplus > 0; i--) {
        if (!have[i].placed) {
          toDeleteIds.push(have[i].id);
          surplus--;
          deleted++;
        }
      }
      if (surplus > 0) {
        placedSurplus.push({ offering_id: g.offering_id, batch_id: g.batch_id, count: surplus });
      }
      kept += have.length - deleted;
    } else {
      kept += have.length;
      let need = want.length - have.length;
      if (need > 0) {
        const present = new Set(have.map((h) => h.seq));
        for (const w of want) {
          if (need <= 0) break;
          if (!present.has(w.seq)) {
            toCreate.push({
              offering_id: w.offering_id,
              batch_id: w.batch_id,
              seq: w.seq,
              faculty_ids: [...w.faculty_ids],
            });
            need--;
          }
        }
      }
    }
  }
  return { toCreate, toDeleteIds, placedSurplus, kept };
}
