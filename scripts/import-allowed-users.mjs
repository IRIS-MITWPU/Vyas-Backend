// Loads the staff spreadsheet into allowed_user (the allowlist for new account creation).
//   npm run import-allowed-users -- "<path to staff list .xlsx>" [--dry-run]
//
// Imports every row of "Faculty staff", and only Lab Assistants and
// Executive - Program Office rows of "Non Teaching" (those have no PRN -> eprn NULL).
// "Resign staff" is ignored. Insert-or-update by email; never deletes rows.
// An EPRN that appears on more than one row is stored as NULL for those rows (with a warning).
import { readFile } from "node:fs/promises";
import XLSX from "xlsx";

const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
const dryRun = process.argv.includes("--dry-run");
if (!file) {
  console.error('Usage: npm run import-allowed-users -- "<path to .xlsx>" [--dry-run]');
  process.exit(1);
}

const NON_TEACHING_DESIGNATIONS = new Set(["lab assistant", "executive - program office"]);
const EMAIL_RE = /^[^\s@]+@mitwpu\.edu\.in$/;

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

// Rows of a sheet as objects keyed by trimmed header text (headers have trailing spaces).
function sheetRows(workbook, name) {
  const sheetName = workbook.SheetNames.find((n) => n.trim() === name);
  if (!sheetName) throw new Error(`Sheet "${name}" not found`);
  const [header, ...rows] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null });
  const keys = header.map(clean);
  return rows
    .map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i]])))
    .filter((r) => clean(r["Faculty Name"]) || clean(r["Email ID"]));
}

function toRecord(r, sheet, withEprn) {
  const rec = {
    email: clean(r["Email ID"]).toLowerCase(),
    full_name: clean(r["Faculty Name"]),
    eprn: withEprn ? clean(r["PRN"]) || null : null,
    phone: String(r["Contact Number"] ?? "").replace(/\D/g, "") || null,
  };
  if (!EMAIL_RE.test(rec.email) || !rec.full_name) {
    throw new Error(`Bad row in "${sheet}": ${JSON.stringify(r)}`);
  }
  return rec;
}

const workbook = XLSX.read(await readFile(file), { type: "buffer" });
const faculty = sheetRows(workbook, "Faculty staff").map((r) => toRecord(r, "Faculty staff", true));
const nonTeaching = sheetRows(workbook, "Non Teaching")
  .filter((r) => NON_TEACHING_DESIGNATIONS.has(clean(r["Designation"]).toLowerCase()))
  .map((r) => toRecord(r, "Non Teaching", false));
const records = [...faculty, ...nonTeaching];

const dupes = records.map((r) => r.email).filter((e, i, all) => all.indexOf(e) !== i);
if (dupes.length) throw new Error(`Duplicate emails in sheet: ${dupes.join(", ")}`);

// An EPRN shared by several rows is a sheet error we can't attribute — store NULL for all of them.
const eprns = records.map((r) => r.eprn).filter(Boolean);
const dupEprns = new Set(eprns.filter((e, i) => eprns.indexOf(e) !== i));
for (const r of records) {
  if (dupEprns.has(r.eprn)) {
    console.warn(`⚠️  EPRN ${r.eprn} is shared by several rows — storing NULL for ${r.email}`);
    r.eprn = null;
  }
}

console.log(`Faculty staff: ${faculty.length}, Non Teaching (filtered): ${nonTeaching.length}, total: ${records.length}`);

if (dryRun) {
  for (const r of records) console.log(`  ${r.email}  ${r.eprn ?? "-"}  ${r.full_name}`);
  console.log("Dry run — nothing written.");
} else {
  const { default: pool } = await import("../database/db.js");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of records) {
      await client.query(
        `INSERT INTO allowed_user (email, full_name, eprn, phone) VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO UPDATE
           SET full_name = EXCLUDED.full_name, eprn = EXCLUDED.eprn, phone = EXCLUDED.phone`,
        [r.email, r.full_name, r.eprn, r.phone]
      );
    }
    await client.query("COMMIT");
    const { rows: [c] } = await client.query("SELECT count(*)::int AS n FROM allowed_user");
    console.log(`✅ Upserted ${records.length} row(s); allowed_user now has ${c.n}`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Import failed:", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
