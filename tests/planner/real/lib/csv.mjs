// Tiny RFC-4180-ish CSV parser (no dependencies). Pure.
// Handles quoted fields, doubled quotes, CRLF/LF, a UTF-8 BOM and blank trailing lines.

/** Parses CSV text into an array of arrays of strings. */
export function parseCsvRows(text) {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i += 1;
    } else if (c === ',') {
      pushField();
      i += 1;
    } else if (c === '\r') {
      if (s[i + 1] === '\n') i += 1;
      pushRow();
      i += 1;
    } else if (c === '\n') {
      pushRow();
      i += 1;
    } else {
      field += c;
      i += 1;
    }
  }
  if (field !== '' || row.length) pushRow();
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Parses CSV text with a header row into [{header: value}] (keys trimmed, values kept as written). */
export function parseCsv(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => {
      o[h] = r[i] ?? '';
    });
    return o;
  });
}
