// Minimal migration runner — the way any DB (dev, RDS) gets its schema.
//   npm run db:migrate                 # apply pending migrations
//   npm run db:migrate -- --baseline   # existing DB: record all migrations as applied, run nothing
//   npm run db:migrate -- --baseline-through=009   # existing DB at 009: record 001-009, then apply the rest
//
// Empty DB (no `profiles` table): applies schema.sql, then every migration.
// Otherwise applies each database/migrations/*.sql not yet in
// schema_migrations, in lexical order, one transaction per file.
//
// An existing DB with no schema_migrations table is refused unless
// --baseline / --baseline-through is given: re-running old migrations is not safe (005's backfill
// would mark every pending account as verified).
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pool from "../database/db.js";

const dbDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "database");
const migrationsDir = path.join(dbDir, "migrations");
const baselineAll = process.argv.includes("--baseline");
const through = process.argv.find((a) => a.startsWith("--baseline-through="))?.split("=")[1];
const baseline = baselineAll || Boolean(through);

async function inTransaction(client, sql) {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

const client = await pool.connect();
try {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const { rows: [state] } = await client.query(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS tracked,
            to_regclass('public.profiles') IS NOT NULL AS has_schema`
  );

  if (!state.tracked && state.has_schema && !baseline) {
    throw new Error(
      "Database has a schema but no schema_migrations table. Verify it is at the latest " +
      "migration, then run with --baseline to record that state (runs no SQL)."
    );
  }

  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename   TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  );

  if (baseline) {
    // A prefix like "009" covers 009_*.sql and everything sorted before it.
    const covered = baselineAll ? files : files.filter((f) => f.slice(0, through.length) <= through);
    for (const f of covered) {
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
        [f]
      );
    }
    console.log(`📌 Baselined ${covered.length} migration(s); no SQL was run for them`);
  }
  if (!baselineAll) {
    if (!state.has_schema) {
      console.log("🆕 Empty database — applying schema.sql");
      await inTransaction(client, await readFile(path.join(dbDir, "schema.sql"), "utf8"));
    }

    const applied = new Set(
      (await client.query("SELECT filename FROM schema_migrations")).rows.map((r) => r.filename)
    );
    const pending = files.filter((f) => !applied.has(f));
    for (const f of pending) {
      const sql = await readFile(path.join(migrationsDir, f), "utf8");
      await inTransaction(
        client,
        `${sql}\n;INSERT INTO schema_migrations (filename) VALUES ('${f.replace(/'/g, "''")}');`
      );
      console.log(`✅ Applied ${f}`);
    }
    console.log(pending.length ? `Done — ${pending.length} applied` : "Up to date — nothing to apply");
  }
} catch (err) {
  console.error("❌ Migration failed:", err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
