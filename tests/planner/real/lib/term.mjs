// Shared by the CLI scripts: the REAL-TEST term key and how to find it in a GET /terms body.
export const TERM_KEY = { academic_year: '2026-27', half: 'odd', branch: 'REAL-TEST' };

/** Finds the REAL-TEST term in a GET /terms `terms` array, or the term with the given id. */
export function findTerm(terms, id = null) {
  if (id) return terms.find((t) => t.id === id) ?? null;
  return terms.find((t) => t.academic_year === TERM_KEY.academic_year && t.half === TERM_KEY.half && t.branch === TERM_KEY.branch) ?? null;
}
