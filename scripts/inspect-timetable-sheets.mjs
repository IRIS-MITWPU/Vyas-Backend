import fs from 'fs/promises';
import path from 'path';
import XLSX from 'xlsx';

const DIR = 'C:\\Users\\Aditya\\Downloads\\code\\web\\VY\\TimeTable_Data';
const TARGET_SHEETS = new Set(['TY-CSE', 'Classroom & Lab Details']);

const files = await fs.readdir(DIR);
for (const f of files) {
  if (!f.endsWith('.xlsx') && !f.endsWith('.xls')) continue;
  const filePath = path.join(DIR, f);
  const buffer = await fs.readFile(filePath);
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  for (const sheetName of workbook.SheetNames) {
    if (!TARGET_SHEETS.has(sheetName.trim())) continue;
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    const nonEmptyRows = rows.filter((r) => r.some((c) => String(c).trim()));
    console.log(`\n=== ${f} :: "${sheetName}" (${nonEmptyRows.length} rows) ===`);
    for (const row of nonEmptyRows.slice(0, 20)) {
      const text = row.map((c) => String(c).trim()).filter(Boolean).join(' | ');
      console.log(`  ${text.slice(0, 220)}`);
    }
  }
}
