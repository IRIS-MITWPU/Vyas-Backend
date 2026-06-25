// services/extractionService.js
import { PDFParse } from 'pdf-parse';
import XLSX from 'xlsx';
import fs from 'fs/promises';
import { IMPORT_CONFIG } from '../config/importConfig.js';

/**
 * Extract raw text from a file based on its mime type.
 * Returns { text: string, needsOcr: boolean }
 */
export async function extractTextFromFile(filePath, mimeType) {
  if (mimeType === 'application/pdf') {
    return extractFromPdf(filePath);
  }
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel'
  ) {
    return { text: extractFromExcel(filePath), needsOcr: false };
  }
  if (mimeType === 'text/csv') {
    return { text: await extractFromCsv(filePath), needsOcr: false };
  }
  throw new Error(`Unsupported mime type: ${mimeType}`);
}

async function extractFromPdf(filePath) {
  const buffer = await fs.readFile(filePath);
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

function extractFromExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  const textParts = [];

  for (const sheetName of workbook.SheetNames) {
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
    textParts.push(`Sheet: ${sheetName}`);
    for (const row of rows) {
      const rowText = row.map((cell) => String(cell).trim()).join(' | ');
      if (rowText.replace(/\|/g, '').trim()) {
        // skip empty rows
        textParts.push(rowText);
      }
    }
  }

  return textParts.join('\n');
}

async function extractFromCsv(filePath) {
  // Try UTF-8 first, then latin-1 as fallback (common in Indian university exports)
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return await fs.readFile(filePath, 'latin1');
  }
}
