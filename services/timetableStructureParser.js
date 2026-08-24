// services/timetableStructureParser.js
//
// Deterministic (non-LLM) parsing of a timetable sheet's already-flattened
// row lines (see extractionService.js's extractFromExcel) into:
//   - gridLines: the actual day/time schedule rows, annotated with in-band
//     "##PANEL: <label>##" markers so llmService.js's chunkText() can split
//     chunks on panel boundaries without ever mixing two panels' lectures.
//   - panels: per-panel {panelLabel, divisions, subjectLookup, labLookup}
//     lookup tables parsed straight from each panel's own Theory/Lab legend
//     tables — used later by legendBackfill.js to resolve a bare subject
//     code + null teacher into the real subject name/teacher for that
//     specific panel (the same code can mean a different teacher in a
//     different panel, so the lookup must stay scoped to its own panel).
//
// Confirmed against 3 real MIT WPU sample workbooks (~15 sheets): a single
// sheet routinely contains multiple panels stacked vertically, panel header
// text varies in spacing ("CSE- Panel- A (CCD1)" vs "CSE-Panel-B (CCD2)"),
// and a panel can cover multiple divisions at once ("CSE-Panel-  G, H, I, J"
// — one shared grid+legend, not four separate panels). Legend header text is
// "Subbject Abbrev." (a real, consistent typo across all sampled files).

const PANEL_PATTERN = /panel/i;
const LEGEND_HEADER_PATTERN = /Sub{1,2}ject\s+Abbrev/i;
const LEGEND_SECTION_TITLE_PATTERN = /^Theory\b.*\bLab\b/i;
const TIME_ROW_PATTERN = /^time\b/i;
// "10.30 to 10.45", "12.45  to 1.30" — the short break-time column headers,
// as opposed to ordinary single-time slot headers like "8.30 a.m.".
const BREAK_HEADER_PATTERN = /(\d{1,2}[.:]\d{2})\s*(?:a\.?m\.?|p\.?m\.?)?\s*to\s*(\d{1,2}[.:]\d{2})/i;

function splitRow(line) {
  return line.split(' | ');
}

// A row collapses to exactly one distinct non-empty value once merge-fill
// has run (see extractFromExcel) when it's a genuine single wide merged
// cell — true for the "Theory | Lab" section title row, regardless of
// exactly which columns the merge spans in a given file.
function singleDistinctValue(cells) {
  const distinct = [...new Set(cells.map((c) => c.trim()).filter(Boolean))];
  return distinct.length === 1 ? distinct[0] : null;
}

// A panel-header row is usually (but not always) a single wide merged cell
// — confirmed real counter-example: a panel header row can carry a SECOND
// merged annotation in adjacent columns on the same row (e.g. "C&J Same
// Structure" next to "CSE-Panel- C (CCD3)"), which breaks the
// single-distinct-value assumption. Scanning for any distinct value that
// contains "panel" is more robust and still safe — ordinary grid/day rows
// don't use that word.
function findPanelLabel(cells) {
  const distinct = [...new Set(cells.map((c) => c.trim()).filter(Boolean))];
  return distinct.find((v) => PANEL_PATTERN.test(v)) || null;
}

function parsePanelHeader(label) {
  const m = label.match(/panel\s*-*\s*([A-Za-z0-9,\s-]+?)(?:\s*\(([^)]+)\))?\s*$/i);
  const divisionsRaw = m ? m[1] : label;
  const divisions = divisionsRaw
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  return { panelLabel: label, divisions: divisions.length ? divisions : [divisionsRaw.trim()] };
}

// Parses "H.MM to H.MM" into a duration in minutes. Returns null if it
// doesn't look like a real break-time range.
function breakColumnDurationMinutes(text) {
  const m = text.match(BREAK_HEADER_PATTERN);
  if (!m) return null;
  const toMinutes = (t) => {
    const [h, mm] = t.replace(':', '.').split('.').map(Number);
    if (Number.isNaN(h) || Number.isNaN(mm)) return null;
    return h * 60 + mm;
  };
  const start = toMinutes(m[1]);
  const end = toMinutes(m[2]);
  if (start === null || end === null) return null;
  const diff = end - start;
  return diff > 0 ? diff : null;
}

/**
 * Detects break/placeholder columns (the R/C/E/S single-letter codes found
 * in real files at short break-time column positions — NOT a literal
 * "RECESS" merged column, which does not appear in any sampled file) from
 * the 3-row TIME header block, and blanks their cell values on grid rows.
 * Off by default (IMPORT_CONFIG.stripBreakColumns) since the letters'
 * semantics were not confirmed from the sampled data — only their
 * consistent position.
 */
function stripBreakColumns(panelLines, headerRowIdx, options) {
  const { breakColumnMaxDurationMinutes } = options;
  const row1 = splitRow(panelLines[headerRowIdx]);
  const row2 = panelLines[headerRowIdx + 1] ? splitRow(panelLines[headerRowIdx + 1]) : [];
  const row3 = panelLines[headerRowIdx + 2] ? splitRow(panelLines[headerRowIdx + 2]) : [];

  const breakColumns = new Set();
  for (let c = 0; c < row1.length; c++) {
    const v1 = (row1[c] || '').trim();
    if (!v1) continue;
    // Real break-column headers are a single cell vertically merged across
    // all 3 TIME header rows, so merge-fill makes it identical in all 3.
    const identicalAcrossRows = v1 === (row2[c] || '').trim() && v1 === (row3[c] || '').trim();
    if (!identicalAcrossRows) continue;
    const duration = breakColumnDurationMinutes(v1);
    if (duration !== null && duration <= breakColumnMaxDurationMinutes) {
      breakColumns.add(c);
    }
  }
  if (breakColumns.size === 0) return panelLines;

  // Cross-validate: only actually blank a flagged column if every day-row's
  // content there is a bare 1-2 letter token (not a real short lecture).
  const dayRowIdxs = [];
  for (let i = headerRowIdx + 3; i < panelLines.length; i++) {
    if (PANEL_PATTERN.test(panelLines[i]) || TIME_ROW_PATTERN.test(panelLines[i])) break;
    dayRowIdxs.push(i);
  }
  const confirmedColumns = [...breakColumns].filter((c) =>
    dayRowIdxs.every((i) => {
      const cells = splitRow(panelLines[i]);
      const v = (cells[c] || '').trim();
      return v === '' || /^[A-Z]{1,2}$/.test(v);
    })
  );
  if (confirmedColumns.length === 0) return panelLines;

  return panelLines.map((line, i) => {
    if (!dayRowIdxs.includes(i)) return line;
    const cells = splitRow(line);
    for (const c of confirmedColumns) cells[c] = '';
    return cells.join(' | ');
  });
}

/**
 * Parses one panel's legend rows (Theory + Lab tables, which sit side by
 * side in the same physical rows once flattened — see module header) into
 * subjectLookup/labLookup maps, using column indices read dynamically from
 * the legend sub-header row rather than hardcoded positions, since
 * Theory/Lab column spans vary per file.
 */
function parseLegendRows(lines, headerRowIdx) {
  const subHeader = splitRow(lines[headerRowIdx]);
  const anchorIdx = subHeader.findIndex((c) => LEGEND_HEADER_PATTERN.test(c));
  if (anchorIdx === -1) return { subjectLookup: new Map(), labLookup: new Map(), consumedThrough: headerRowIdx };

  // Every sampled legend sub-header follows this fixed 6-label order:
  // Subbject Abbrev. | Subject Name | Subject Teacher | Subject Name | Batches | Lab Locations
  // A single label can span several raw columns after merge-fill (e.g.
  // "Subject Name" repeated across 3 merged columns) — take the START
  // column of each run of a NEW distinct value, not every non-empty
  // column, or a merged run gets mistaken for multiple fields.
  const fieldIdxs = [anchorIdx];
  let lastValue = subHeader[anchorIdx].trim();
  for (let c = anchorIdx + 1; c < subHeader.length && fieldIdxs.length < 6; c++) {
    const v = subHeader[c].trim();
    if (v && v !== lastValue) {
      fieldIdxs.push(c);
      lastValue = v;
    }
  }
  if (fieldIdxs.length < 6) return { subjectLookup: new Map(), labLookup: new Map(), consumedThrough: headerRowIdx };

  const [codeIdx, theoryNameIdx, teacherIdx, labNameIdx, batchesIdx, roomIdx] = fieldIdxs;
  const subjectLookup = new Map();
  const labLookup = new Map();

  let i = headerRowIdx + 1;
  for (; i < lines.length; i++) {
    if (PANEL_PATTERN.test(lines[i]) || TIME_ROW_PATTERN.test(lines[i])) break;
    const cells = splitRow(lines[i]);
    const code = (cells[codeIdx] || '').trim();
    const theoryName = (cells[theoryNameIdx] || '').trim();
    const teacher = (cells[teacherIdx] || '').trim();
    const labName = (cells[labNameIdx] || '').trim();
    const batches = (cells[batchesIdx] || '').trim();
    const room = (cells[roomIdx] || '').trim();

    if (code && theoryName) {
      subjectLookup.set(normalizeCode(code), { subjectName: theoryName, teacher: teacher || null });
    }
    if (labName && (batches || room)) {
      labLookup.set(normalizeCode(labName), { batches: batches || null, room: room || null });
    }
  }
  return { subjectLookup, labLookup, consumedThrough: i - 1 };
}

export function normalizeCode(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * @param {string[]} dataLines - one already-flattened, newline-collapsed
 *   pipe-joined line per Excel row for a single sheet (see extractFromExcel)
 * @param {string} sheetName
 * @param {{stripBreakColumns?: boolean, breakColumnMaxDurationMinutes?: number}} options
 * @returns {{gridLines: string[], panels: object[]}}
 */
export function parseSheetStructure(dataLines, sheetName, options = {}) {
  const { stripBreakColumns: doStripBreaks = false, breakColumnMaxDurationMinutes = 20 } = options;

  const panels = [];
  const gridLines = [];
  let currentPanel = { panelLabel: null, divisions: [], subjectLookup: new Map(), labLookup: new Map() };
  let currentPanelLines = [];

  const flushPanel = () => {
    let lines = currentPanelLines;
    if (doStripBreaks) {
      const timeHeaderIdx = lines.findIndex((l) => TIME_ROW_PATTERN.test(l));
      if (timeHeaderIdx !== -1) {
        lines = stripBreakColumns(lines, timeHeaderIdx, { breakColumnMaxDurationMinutes });
      }
    }
    if (lines.length) {
      gridLines.push(`##PANEL: ${currentPanel.panelLabel ?? '(none)'}##`);
      gridLines.push(...lines);
    }
    panels.push({
      sheetName,
      panelLabel: currentPanel.panelLabel,
      divisions: currentPanel.divisions,
      subjectLookup: currentPanel.subjectLookup,
      labLookup: currentPanel.labLookup,
    });
    currentPanelLines = [];
  };

  let i = 0;
  while (i < dataLines.length) {
    const line = dataLines[i];
    const cells = splitRow(line);
    const panelLabelCandidate = findPanelLabel(cells);

    if (panelLabelCandidate) {
      // New panel begins — flush whatever grid content belonged to the
      // previous panel (or the pre-panel "(none)" bucket) first.
      flushPanel();
      const { panelLabel, divisions } = parsePanelHeader(panelLabelCandidate);
      currentPanel = { panelLabel, divisions, subjectLookup: new Map(), labLookup: new Map() };
      currentPanelLines.push(line);
      i++;
      continue;
    }

    if (LEGEND_HEADER_PATTERN.test(line)) {
      // The "Theory | Lab" section-title row directly above the legend
      // sub-header was already pushed to currentPanelLines in the previous
      // iteration (it doesn't itself match any pattern checked so far) —
      // pull it back out so it doesn't leak into the LLM's grid input.
      if (
        currentPanelLines.length &&
        currentPanelLines[currentPanelLines.length - 1] === dataLines[i - 1] &&
        LEGEND_SECTION_TITLE_PATTERN.test(dataLines[i - 1])
      ) {
        currentPanelLines.pop();
      }
      const { subjectLookup, labLookup, consumedThrough } = parseLegendRows(dataLines, i);
      for (const [k, v] of subjectLookup) currentPanel.subjectLookup.set(k, v);
      for (const [k, v] of labLookup) currentPanel.labLookup.set(k, v);
      // Legend rows (and the row(s) immediately after them, e.g. the
      // trailer/signature block) are deliberately NOT added to
      // currentPanelLines — they never reach the grid-extraction LLM call.
      i = consumedThrough + 1;
      continue;
    }

    currentPanelLines.push(line);
    i++;
  }
  flushPanel();

  // Sheets with no "Panel" header anywhere still get one implicit
  // whole-sheet panel (panelLabel: null) — legend rows are still stripped
  // and any legend found still becomes a usable (if unscoped) lookup table.
  return { gridLines, panels };
}

export function serializePanels(panels) {
  return panels.map((p) => ({
    sheetName: p.sheetName,
    panelLabel: p.panelLabel,
    divisions: p.divisions,
    subjectLookup: [...p.subjectLookup.entries()],
    labLookup: [...p.labLookup.entries()],
  }));
}

export function deserializePanels(serialized) {
  return (serialized || []).map((p) => ({
    sheetName: p.sheetName,
    panelLabel: p.panelLabel,
    divisions: p.divisions,
    subjectLookup: new Map(p.subjectLookup || []),
    labLookup: new Map(p.labLookup || []),
  }));
}
