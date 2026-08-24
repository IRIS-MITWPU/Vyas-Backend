import fs from 'fs/promises';
import path from 'path';
import { extractTextFromFile } from '../services/extractionService.js';

const DIR = 'C:\\Users\\Aditya\\Downloads\\code\\web\\VY\\TimeTable_Data';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const files = await fs.readdir(DIR);
for (const f of files) {
  if (!f.endsWith('.xlsx')) continue;
  const { text } = await extractTextFromFile(path.join(DIR, f), XLSX_MIME);
  const includedSheets = [...text.matchAll(/^Sheet: (.+)$/gm)].map((m) => m[1]);
  console.log(`\n${f}\n  Included sheets: ${includedSheets.join(' | ')}`);
}
