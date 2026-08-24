// Throwaway inventory script for test-1 step 1.
// For every file in TimeTable/, prints filename, extension, and (for Excel
// files) every sheet name with its row/column count. Ground truth for
// "did we extract everything?" before touching the multi-sheet fix.
import fs from "fs";
import path from "path";
import XLSX from "xlsx";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TIMETABLE_DIR = path.join(__dirname, "..", "TimeTable");

function sheetDimensions(worksheet) {
  const ref = worksheet["!ref"];
  if (!ref) return { rows: 0, cols: 0 };
  const range = XLSX.utils.decode_range(ref);
  return {
    rows: range.e.r - range.s.r + 1,
    cols: range.e.c - range.s.c + 1,
  };
}

const files = fs.readdirSync(TIMETABLE_DIR).filter((f) => {
  const full = path.join(TIMETABLE_DIR, f);
  return fs.statSync(full).isFile() && !f.startsWith("_");
});

let out = "# TimeTable inventory\n\n";
out += `Generated ${new Date().toISOString()} by \`scripts/inventory.mjs\` (test-1 step 1).\n\n`;

for (const file of files) {
  const full = path.join(TIMETABLE_DIR, file);
  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(full);
  out += `## ${file}\n\n`;
  out += `- Extension: \`${ext}\`\n`;
  out += `- Size: ${stat.size} bytes\n`;

  if (ext === ".xlsx" || ext === ".xls") {
    try {
      const buf = fs.readFileSync(full);
      const workbook = XLSX.read(buf, { type: "buffer" });
      out += `- Sheets: ${workbook.SheetNames.length}\n\n`;
      out += `| # | Sheet name | Rows | Cols |\n|---|---|---|---|\n`;
      workbook.SheetNames.forEach((name, i) => {
        const { rows, cols } = sheetDimensions(workbook.Sheets[name]);
        out += `| ${i + 1} | ${name} | ${rows} | ${cols} |\n`;
      });
      out += "\n";
    } catch (err) {
      out += `- **ERROR reading workbook:** ${err.message}\n\n`;
    }
  } else {
    out += "\n";
  }
}

const outPath = path.join(TIMETABLE_DIR, "_inventory.md");
fs.writeFileSync(outPath, out);
console.log(`Wrote ${outPath}`);
console.log(out);
