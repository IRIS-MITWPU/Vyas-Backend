// Throwaway extraction-only harness for test-1 step 2.
// Calls extractionService directly on each file in TimeTable/ — no LLM, no
// DB, no queue — and dumps extracted text per file per sheet, so a
// multi-sheet bug can't be confused with an LLM/queue failure.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { extractTextFromFile } from "../services/extractionService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TIMETABLE_DIR = path.join(__dirname, "..", "TimeTable");

const MIME_BY_EXT = {
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
};

const files = fs.readdirSync(TIMETABLE_DIR).filter((f) => {
  const full = path.join(TIMETABLE_DIR, f);
  return fs.statSync(full).isFile() && !f.startsWith("_");
});

let out = "# Extraction-only harness output\n\n";
out += `Generated ${new Date().toISOString()} by \`scripts/extraction-harness.mjs\` (test-1 step 2). No LLM/DB/queue involved.\n\n`;

for (const file of files) {
  const full = path.join(TIMETABLE_DIR, file);
  const ext = path.extname(file).toLowerCase();
  const mimeType = MIME_BY_EXT[ext];

  out += `## ${file}\n\n`;
  if (!mimeType) {
    out += `- Skipped: no MIME mapping for extension \`${ext}\`\n\n`;
    continue;
  }

  try {
    const { text, needsOcr } = await extractTextFromFile(full, mimeType);
    const sheetHeaders = [...text.matchAll(/^Sheet: (.+)$/gm)].map((m) => m[1]);
    out += `- MIME type used: \`${mimeType}\`\n`;
    out += `- needsOcr: ${needsOcr}\n`;
    out += `- Extracted text length: ${text.length} chars\n`;
    out += `- Sheet headers found in extracted text: ${sheetHeaders.length}\n`;
    sheetHeaders.forEach((s, i) => (out += `  ${i + 1}. ${s}\n`));
    out += `\n<details><summary>First 2000 chars of extracted text</summary>\n\n\`\`\`\n${text.slice(0, 2000)}\n\`\`\`\n</details>\n\n`;
  } catch (err) {
    out += `- **ERROR during extraction:** ${err.message}\n\n`;
  }
}

const outPath = path.join(TIMETABLE_DIR, "_extraction_harness_output.md");
fs.writeFileSync(outPath, out);
console.log(`Wrote ${outPath}`);
console.log(out.slice(0, 3000));
