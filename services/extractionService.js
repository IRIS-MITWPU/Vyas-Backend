// services/extractionService.js
import { PDFParse } from 'pdf-parse';
import XLSX from 'xlsx';
import { IMPORT_CONFIG } from '../config/importConfig.js';
import { parseSheetStructure } from './timetableStructureParser.js';

/**
 * Extract raw text from a file based on its mime type.
 * Returns { text: string, needsOcr: boolean, panels: PanelInfo[] }
 * (panels is only ever non-empty for Excel — PDF/CSV have no structured
 * panel/legend concept to extract)
 */
export async function extractTextFromFile(buffer, mimeType) {
  if (mimeType === 'application/pdf') {
    return { ...(await extractFromPdf(buffer)), panels: [] };
  }
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel'
  ) {
    const { text, panels } = await extractFromExcel(buffer);
    return { text, needsOcr: false, panels };
  }
  if (mimeType === 'text/csv') {
    return { text: extractFromCsv(buffer), needsOcr: false, panels: [] };
  }
  throw new Error(`Unsupported mime type: ${mimeType}`);
}

async function extractFromPdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const text = result.text || '';
    const needsOcr = text.trim().length < IMPORT_CONFIG.ocrTextThreshold;
    return { text, needsOcr };
  } catch (err) {
    // A corrupted/unreadable text layer is equivalent to a scanned PDF — fall through to OCR.
    console.error('pdf-parse failed, falling back to OCR:', err.message);
    return { text: '', needsOcr: true };
  } finally {
    await parser.destroy();
  }
}

// Matches full or abbreviated weekday names as whole words — the one signal
// every real class-schedule sheet reliably has (each day is a row/column
// label) and non-timetable sheets (lab/equipment inventories, room-allocation
// lists, etc.) reliably don't. Verified against real MIT WPU timetable
// exports: every genuine timetable sheet has 5+ matches; the one confirmed
// non-timetable sheet in that sample ("Classroom & Lab Details" — a
// room/machine/lab-assistant inventory) had zero.
const WEEKDAY_PATTERN = /\b(mon(day)?|tue(s|sday)?|wed(nesday)?|thu(r|rs|rsday)?|fri(day)?|sat(urday)?|sun(day)?)\b/gi;
// A sheet needs at least this many distinct weekday mentions to count as a
// real schedule grid — 1 is too easy to hit by accident (e.g. a stray date
// or a person's name); real timetables in practice have one row per day.
const MIN_WEEKDAY_MENTIONS = 2;

function isLikelyTimetableSheet(dataLines) {
  const text = dataLines.join(' ');
  const matches = text.match(WEEKDAY_PATTERN);
  return (matches?.length ?? 0) >= MIN_WEEKDAY_MENTIONS;
}

// Collapses newlines *inside* a single cell's own value to a space before
// trimming. A wrapped multi-division cell (e.g. Excel literal
// "A1 -PBLIII \nA2 -CNL") otherwise survives into the pipe-joined row line
// with its internal \n intact — and since llmService.js's chunkBySize()
// falls back to splitting Excel text by /\n/ (Excel rows have no blank-line
// paragraph breaks), that embedded newline gets mistaken for a row boundary,
// letting a chunk cut land mid-cell and separate a multi-division cell's
// continuation (and its room info) from its own day/row context.
function collapseCellNewlines(cell) {
  return String(cell).replace(/\r\n|\r|\n/g, ' ').trim();
}

async function extractFromExcel(buffer) {
  // XLSX.readFile() requires XLSX.set_fs() to have been called first when
  // the "xlsx" package is loaded via `import` (resolves to xlsx.mjs, whose
  // internal _fs is unset until set_fs() runs) — nothing in this codebase
  // ever calls it, so readFile() throws "Cannot access file" for every
  // single Excel upload, regardless of sheet count. Reading as a buffer
  // sidesteps set_fs() entirely and matches how PDF/CSV are already read.
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const textParts = [];
  const allPanels = [];

  for (const sheetName of workbook.SheetNames) {
    try {
      const sheet = workbook.Sheets[sheetName];

      // Unmerge cells: fill merged regions with top-left value
      if (sheet['!merges']) {
        for (const merge of sheet['!merges']) {
          const topLeft = XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c });
          const topLeftValue = sheet[topLeft]?.v;
          for (let r = merge.s.r; r <= merge.e.r; r++) {
            for (let c = merge.s.c; c <= merge.e.c; c++) {
              const cellAddr = XLSX.utils.encode_cell({ r, c });
              if (!sheet[cellAddr]) {
                sheet[cellAddr] = { v: topLeftValue, t: 's' };
              }
            }
          }
        }
      }

      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      const dataLines = [];
      for (const row of rows) {
        const rowText = row.map((cell) => collapseCellNewlines(cell)).join(' | ');
        if (rowText.replace(/\|/g, '').trim()) {
          // skip empty rows
          dataLines.push(rowText);
        }
      }

      // Skip sheets with no real data — an empty "Sheet: X" header with
      // nothing under it is just noise for the LLM step.
      if (dataLines.length === 0) continue;

      // Skip sheets that aren't actually a class schedule — e.g. lab/device
      // inventory or room-allocation lists uploaded alongside the real
      // timetable sheets in the same workbook. Sending these to the LLM
      // wastes chunk/retry budget and risks hallucinated "lectures" built
      // from equipment/asset rows.
      if (!isLikelyTimetableSheet(dataLines)) {
        console.log(`[Extraction] Sheet "${sheetName}" has no weekday grid pattern — treated as non-timetable data, skipped`);
        continue;
      }

      // Panel-boundary + legend-table detection: separates per-panel
      // code->teacher/room lookups (kept out of LLM input, used later for
      // deterministic backfill) from the actual grid rows sent to the LLM.
      // Legend rows are deterministically parsed here rather than run
      // through the "extract a lecture" prompt, since they have no
      // day/time and would otherwise produce pseudo-lectures with a real
      // teacher/subject but null weekday/start_time.
      const { gridLines, panels } = parseSheetStructure(dataLines, sheetName, {
        stripBreakColumns: IMPORT_CONFIG.stripBreakColumns,
        breakColumnMaxDurationMinutes: IMPORT_CONFIG.breakColumnMaxDurationMinutes,
      });
      allPanels.push(...panels);

      textParts.push(`Sheet: ${sheetName}`);
      textParts.push(...gridLines.map(expandMultiDivisionLine));
    } catch (err) {
      // One sheet's failure (e.g. a malformed merge range) must not abort
      // extraction of the file's other sheets — same "one bad file doesn't
      // abort the job" design used elsewhere in this pipeline.
      console.error(`[Extraction] Sheet "${sheetName}" failed, skipping:`, err.message);
    }
  }

  return { text: textParts.join('\n'), panels: allPanels };
}

// Matches a division/batch token like "A1", "A2", "F1" acting as a prefix
// before that division's subject content, e.g. "A1-DSL A2-MMAL A3-CNL" or
// (after collapseCellNewlines) "A1 -PBLIII  A2 -CNL". Confirmed against 3
// real MIT WPU sample files — no comma-separated form was found in any of
// them, only this prefix form and the suffix-parenthetical form below.
const DIVISION_PREFIX_PATTERN = /(?:^|\s)([A-Z]{1,2}\d)\s*-\s*/g;
// Matches "<subject> (<division>)" pairs, e.g. "PE-III(A1)   BDT(A2)".
const DIVISION_SUFFIX_PATTERN = /([A-Za-z0-9&+./-]+(?:\s+[A-Za-z0-9&+./-]+)*)\s*\(([^)]+)\)/g;

// Splits one multi-division cell's text into "[DIVISION: content]; ..."
// tags so the LLM can read each division's lecture as a distinct entry
// instead of trying to flatten "A1-DS-I L, A2-OSL" into one malformed row.
// Only called on already-isolated cell text (see expandMultiDivisionLine),
// never on a whole pipe-joined row — legend cells like "PE3-Gen AI" would
// otherwise false-positive on the prefix pattern.
function expandMultiDivisionCell(text) {
  const prefixMatches = [...text.matchAll(DIVISION_PREFIX_PATTERN)];
  if (prefixMatches.length >= 1) {
    const parts = prefixMatches
      .map((m, i) => {
        const start = m.index + m[0].length;
        const end = i + 1 < prefixMatches.length ? prefixMatches[i + 1].index : text.length;
        const content = text.slice(start, end).trim();
        return content ? `[${m[1]}: ${content}]` : null;
      })
      .filter(Boolean);
    if (parts.length) return parts.join('; ');
  }

  const suffixMatches = [...text.matchAll(DIVISION_SUFFIX_PATTERN)];
  if (suffixMatches.length >= 2) {
    return suffixMatches.map((m) => `[${m[2].trim()}: ${m[1].trim()}]`).join('; ');
  }

  return text;
}

// Applies expandMultiDivisionCell per-column to a pipe-joined grid row line
// (only called on gridLines, never on legend lines — parseSheetStructure has
// already removed those — so legend subject codes like "PE3-Gen AI" are
// never at risk of the prefix pattern misfiring on them).
function expandMultiDivisionLine(line) {
  if (line.startsWith('##PANEL:')) return line;
  return line.split(' | ').map(expandMultiDivisionCell).join(' | ');
}

function extractFromCsv(buffer) {
  return buffer.toString('utf-8');
}
