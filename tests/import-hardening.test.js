// tests/import-hardening.test.js — run via `npm test`
//
// Regression tests for the import-pipeline findings (audit F5/F6/F7, plan
// Phase 4). Unit-level: no server, DB or Redis needed. Hostile fixtures are
// generated here at runtime (nothing large/hostile is committed), and every
// hostile case runs in a child process with a small heap and a timeout, so a
// regression shows up as a failed assertion instead of an OOM'd test runner.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";
import XLSX from "xlsx";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mod = (rel) => pathToFileURL(path.join(repo, rel)).href;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const tmp = mkdtempSync(path.join(tmpdir(), "vyas-import-"));

function writeTmp(name, buf) {
  const p = path.join(tmp, name);
  writeFileSync(p, buf);
  return p;
}

// Runs `body` (an async ESM snippet that sets `result`) in a fresh node with
// a capped heap. Returns { status, result, stderr }.
function isolated(body, { heapMb = 256, timeout = 30000, env = {} } = {}) {
  const code = `let result; ${body}\nprocess.stdout.write("@@RESULT@@" +JSON.stringify(result), () => process.exit(0));`;
  const r = spawnSync(process.execPath, [`--max-old-space-size=${heapMb}`, "--input-type=module", "-e", code], {
    cwd: repo,
    encoding: "utf8",
    timeout,
    env: { ...process.env, ...env },
  });
  let result;
  try { result = JSON.parse(r.stdout.split("@@RESULT@@").pop()); } catch { /* crashed or timed out */ }
  return { status: r.status, signal: r.signal, result, stderr: r.stderr?.slice(-500) };
}

function xlsxBuffer(aoa, patch = () => {}) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  patch(ws);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// `patchWorkbook` (a JS body over `wb`) lets a test inflate parsed workbook
// properties (e.g. !ref) that XLSX.write can't emit without iterating them.
const extractSnippet = (file, patchWorkbook = "") => `
  const { extractTextFromFile } = await import(${JSON.stringify(mod("services/extractionService.js"))});
  const { readFileSync } = await import("node:fs");
  const XLSX = (await import("xlsx")).default;
  const realRead = XLSX.read;
  XLSX.read = (...a) => { const wb = realRead(...a); ${patchWorkbook} return wb; };
  const t0 = Date.now();
  try {
    const r = await extractTextFromFile(readFileSync(${JSON.stringify(file)}), ${JSON.stringify(XLSX_MIME)});
    result = { ok: true, ms: Date.now() - t0, textLen: r.text.length };
  } catch (e) {
    result = { ok: false, ms: Date.now() - t0, error: e.message };
  }`;

// ============================================================
// 4.1 [F7] — merged-cell expansion OOM
// ============================================================

test("4.1 F7: a merge declared far beyond the sheet (A2:XFD1048576) is clamped, not expanded", () => {
  const file = writeTmp("f7-merge.xlsx", xlsxBuffer([["Mon", "Tue", "Wed"], ["x"]], (ws) => {
    ws["!merges"] = [{ s: { r: 1, c: 0 }, e: { r: 1048575, c: 16383 } }];
  }));
  const r = isolated(extractSnippet(file));
  assert.equal(r.status, 0, `extraction process crashed (signal ${r.signal}): ${r.stderr}`);
  assert.equal(r.result.ok, true, r.result.error);
  assert.ok(r.result.ms < 5000, `took ${r.result.ms}ms`);
});

test("4.1 F7: a merge that fills more cells than the cap is rejected fast", () => {
  // 260k cells: under the sheet cap, over the merge-fill cap
  const file = writeTmp("f7-fill.xlsx", xlsxBuffer([["Mon", "Tue"], ["x"]]));
  const r = isolated(extractSnippet(file, `
    const ws = wb.Sheets.Sheet1;
    ws["!ref"] = "A1:Z10000";
    ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 9999, c: 25 } }];`));
  assert.equal(r.status, 0, `extraction process crashed (signal ${r.signal}): ${r.stderr}`);
  assert.equal(r.result.ok, false);
  assert.match(r.result.error, /too large/i);
  assert.ok(r.result.ms < 5000, `took ${r.result.ms}ms`);
});

test("4.1 F7: a sheet whose declared range is enormous is rejected fast", () => {
  const file = writeTmp("f7-ref.xlsx", xlsxBuffer([["Mon", "Tue"], ["x", "y"]]));
  const r = isolated(extractSnippet(file, `wb.Sheets.Sheet1["!ref"] = "A1:XFD1048576";`));
  assert.equal(r.status, 0, `extraction process crashed (signal ${r.signal}): ${r.stderr}`);
  assert.equal(r.result.ok, false);
  assert.match(r.result.error, /too large/i);
  assert.ok(r.result.ms < 5000, `took ${r.result.ms}ms`);
});

test("4.1: a normal merged cell is still filled across its range", async () => {
  const { extractTextFromFile } = await import(mod("services/extractionService.js"));
  const buf = xlsxBuffer(
    [["Day", "9:00", "10:00", "11:00"], ["Mon", "Maths", null, "Chem"], ["Tue", "Physics", "Bio", "Art"]],
    (ws) => { ws["!merges"] = [{ s: { r: 1, c: 1 }, e: { r: 1, c: 2 } }]; }
  );
  const { text } = await extractTextFromFile(buf, XLSX_MIME);
  assert.match(text, /Mon \| Maths \| Maths \| Chem/);
});

// ============================================================
// 4.2 [F5] — regex backtracking
// ============================================================

test("4.2 F5: panel-header and division regexes run in bounded time on hostile cells", () => {
  const r = isolated(`
    const { parseSheetStructure } = await import(${JSON.stringify(mod("services/timetableStructureParser.js"))});
    const { expandMultiDivisionCell } = await import(${JSON.stringify(mod("services/extractionService.js"))});
    const opts = { stripBreakColumns: false, breakColumnMaxDurationMinutes: 20 };
    const times = {};
    for (const n of [200, 5000, 20000]) {
      const t0 = performance.now();
      parseSheetStructure(["Mon | Tue", "panel" + " ".repeat(n) + "!"], "S", opts);
      times["panel" + n] = performance.now() - t0;
    }
    for (const cell of ["a ".repeat(8000), "PE-III(A1) " + "x ".repeat(8000)]) {
      const t0 = performance.now();
      expandMultiDivisionCell(cell);
      times["div" + cell.length] = performance.now() - t0;
    }
    result = times;
  `, { timeout: 20000 });
  assert.equal(r.status, 0, `timed out or crashed (signal ${r.signal}): ${r.stderr}`);
  for (const [k, ms] of Object.entries(r.result)) {
    assert.ok(ms < 100, `${k} took ${ms.toFixed(1)}ms`);
  }
});

test("4.2: real panel headers still parse the same way", async () => {
  const { parseSheetStructure } = await import(mod("services/timetableStructureParser.js"));
  const opts = { stripBreakColumns: false, breakColumnMaxDurationMinutes: 20 };
  const cases = {
    "CSE- Panel- A (CCD1)": ["A"],
    "CSE-Panel-B (CCD2)": ["B"],
    "CSE-Panel-  G, H, I, J": ["G", "H", "I", "J"],
    "Panel   -  C": ["C"],
  };
  for (const [label, divisions] of Object.entries(cases)) {
    const { panels } = parseSheetStructure([`${label} | `, "Mon | x", "Tue | y"], "S", opts);
    const panel = panels.find((p) => p.panelLabel === label); // panels[0] is the pre-panel bucket
    assert.deepEqual(panel.divisions, divisions, label);
  }
});

// ============================================================
// 4.3 [F6] — PDF limits (page / text caps). Containment of a real
// decompression bomb is tested with the worker-thread runner (4.4).
// ============================================================

// Minimal valid PDF: one page per entry of `contents` (raw content-stream
// bytes), optionally Flate-compressed.
export function buildPdf(contents, { deflate = false } = {}) {
  const objs = [];
  const add = (body) => objs.push(body) && objs.length;
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add(Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"));
  const kids = [];
  for (const raw of contents) {
    const data = deflate ? zlib.deflateSync(raw, { level: 9 }) : raw;
    const content = add(Buffer.concat([
      Buffer.from(`<< /Length ${data.length}${deflate ? " /Filter /FlateDecode" : ""} >>\nstream\n`),
      data,
      Buffer.from("\nendstream"),
    ]));
    kids.push(add(Buffer.from(
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`
    )));
  }
  objs[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  objs[pagesObj - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`);

  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets = [];
  let pos = parts[0].length;
  objs.forEach((body, i) => {
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
    offsets.push(pos);
    parts.push(chunk);
    pos += chunk.length;
  });
  const xref = [`xref\n0 ${objs.length + 1}\n`, "0000000000 65535 f \n",
    ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  return Buffer.concat(parts);
}

const textPage = (s) => Buffer.from(`BT /F1 12 Tf 72 720 Td (${s}) Tj ET`);

const pdfSnippet = (file) => `
  const { extractTextFromFile } = await import(${JSON.stringify(mod("services/extractionService.js"))});
  const { readFileSync } = await import("node:fs");
  try {
    const r = await extractTextFromFile(readFileSync(${JSON.stringify(file)}), "application/pdf");
    result = { ok: true, text: r.text, needsOcr: r.needsOcr };
  } catch (e) {
    result = { ok: false, error: e.message };
  }`;

test("4.3: a normal text PDF still extracts", () => {
  const file = writeTmp("ok.pdf", buildPdf([textPage("Monday 9:00 Maths Room 101 ".repeat(8))]));
  const r = isolated(pdfSnippet(file));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result.ok, true, r.result.error);
  assert.match(r.result.text, /Monday 9:00 Maths/);
});

test("4.3 F6: PDFs over the page cap are rejected (not OCR'd)", () => {
  const file = writeTmp("pages.pdf", buildPdf([1, 2, 3, 4].map((n) => textPage(`page ${n}`))));
  const r = isolated(pdfSnippet(file), { env: { IMPORT_PDF_MAX_PAGES: "3" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result.ok, false);
  assert.match(r.result.error, /too many pages/i);
});

test("4.3 F6: extracted text over the cap is rejected", () => {
  const file = writeTmp("text.pdf", buildPdf([Buffer.from(`BT /F1 10 Tf 20 780 Td 12 TL ${Array.from({ length: 50 }, () => `(${"A".repeat(60)}) Tj T*`).join(" ")} ET`)]));
  const r = isolated(pdfSnippet(file), { env: { IMPORT_MAX_EXTRACTED_CHARS: "1000" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result.ok, false);
  assert.match(r.result.error, /too much text/i);
});

// ============================================================
// 4.4 — extraction runs in a capped worker thread
// ============================================================

const runnerSnippet = (file, mime, opts = {}) => `
  const { extractInWorker } = await import(${JSON.stringify(mod("services/extractionRunner.js"))});
  const { readFileSync } = await import("node:fs");
  let ticks = 0; const iv = setInterval(() => ticks++, 50);
  const t0 = Date.now();
  try {
    const r = await extractInWorker(readFileSync(${JSON.stringify(file)}), ${JSON.stringify(mime)}, ${JSON.stringify(opts)});
    result = { ok: true, ms: Date.now() - t0, text: r.text, panels: r.panels.length, isMap: r.panels[0]?.subjectLookup instanceof Map };
  } catch (e) {
    result = { ok: false, ms: Date.now() - t0, error: e.message, ticks };
  }
  clearInterval(iv);`;

test("4.4: the runner returns the same result shape (panels keep their Maps)", () => {
  const file = writeTmp("runner.xlsx", xlsxBuffer([["Mon", "Tue"], ["a", "b"]]));
  const r = isolated(runnerSnippet(file, XLSX_MIME));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result.ok, true, r.result.error);
  assert.match(r.result.text, /Mon \| Tue/);
  assert.equal(r.result.isMap, true);
});

test("4.4: limit errors from the thread reach the caller with their message", () => {
  const file = writeTmp("runner-pages.pdf", buildPdf([1, 2, 3, 4].map((n) => textPage(`p${n}`))));
  const r = isolated(runnerSnippet(file, "application/pdf"), { env: { IMPORT_PDF_MAX_PAGES: "3" } });
  assert.equal(r.result.ok, false);
  assert.match(r.result.error, /too many pages/i);
});

test("4.4 F6: a flate-bomb PDF is killed at the memory cap, and the caller's event loop keeps running", () => {
  // 300 MB of spaces deflates to ~300 KB. The thread's heap limit doesn't
  // cover typed-array growth; the watchdog does.
  const file = writeTmp("bomb.pdf", buildPdf([Buffer.alloc(300 * 1024 * 1024, 0x20)], { deflate: true }));
  const r = isolated(runnerSnippet(file, "application/pdf", { memMb: 100 }), { heapMb: 256, timeout: 60000 });
  assert.equal(r.status, 0, `caller crashed (signal ${r.signal}): ${r.stderr}`);
  assert.equal(r.result.ok, false);
  assert.match(r.result.error, /memory limit/i);
  assert.ok(r.result.ticks > 5, `event loop starved (${r.result.ticks} ticks in ${r.result.ms}ms)`);
});

test("4.4: extraction that outlives the timeout is terminated", () => {
  const file = writeTmp("slow.xlsx", xlsxBuffer([["Mon", "Tue"], ["a", "b"]]));
  const r = isolated(runnerSnippet(file, XLSX_MIME, { timeoutMs: 1 }));
  assert.equal(r.result.ok, false);
  assert.match(r.result.error, /timed out/i);
});

// ============================================================
// 4.5 — worker.js runs the background workers as their own process
// ============================================================

test("4.5: `node worker.js` starts the email + import workers", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["worker.js"], { cwd: repo, env: process.env });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const started = new Promise((resolve) => {
    const iv = setInterval(() => {
      if (/Email worker started/.test(out) && /import worker started/.test(out)) { clearInterval(iv); resolve(true); }
    }, 100);
    setTimeout(() => { clearInterval(iv); resolve(false); }, 20000);
  });
  const ok = await started;
  child.kill();
  assert.ok(ok, `workers did not start:\n${out.slice(-600)}`);
});

// ============================================================
// 4.6 — untrusted LLM output + upload content checks
// ============================================================

test("4.6: malformed LLM lectures are dropped or bounded before normalization/storage", () => {
  const r = isolated(`
    const { parseAndValidateLlmResponse: parse } = await import(${JSON.stringify(mod("services/llmService.js"))});
    const { normalizeLlmLecture } = await import(${JSON.stringify(mod("services/normalizationService.js"))});
    const good = { teacherName: "Dr A", subject: "Maths", roomNumber: "101", weekday: "Monday",
                   startTime: "09:00", durationMinutes: 60, confidence: 0.9, batch: null, lectureType: "CLASSROOM" };
    const out = parse(JSON.stringify({ lectures: [
      good, null, "x", 7, { teacherName: 5 }, { subject: "S".repeat(10000) },
      { ...good, evil: "z".repeat(100000) },
    ]}));
    let normalizeThrew = false;
    try { out.lectures.forEach(normalizeLlmLecture); } catch { normalizeThrew = true; }
    let allBad = null;
    try { parse(JSON.stringify({ lectures: [null, 3] })); } catch (e) { allBad = e.message; }
    result = { kept: out.lectures.length, hasEvil: out.lectures.some((l) => "evil" in l), normalizeThrew, allBad };
  `);
  assert.equal(r.result.kept, 2, JSON.stringify(r.result));   // good + the one with the extra key (stripped)
  assert.equal(r.result.hasEvil, false);
  assert.equal(r.result.normalizeThrew, false);
  assert.match(r.result.allBad, /no valid lecture/i);
});

test("4.6: upload content must match the declared type (magic bytes)", async () => {
  const { contentMatchesMime: ok } = await import(mod("utils/fileSniff.js"));
  const PDF = "application/pdf", CSV = "text/csv", XLS = "application/vnd.ms-excel";
  assert.equal(ok(buildPdf([textPage("x")]).subarray(0, 4096), PDF), true);
  assert.equal(ok(xlsxBuffer([["a"]]).subarray(0, 4096), XLSX_MIME), true);
  assert.equal(ok(Buffer.from("Day,Mon\nTue,x\n"), CSV), true);
  assert.equal(ok(Buffer.from("Day,Mon\n"), XLS), true); // Windows sends .csv as ms-excel
  assert.equal(ok(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 1, 2]), XLS), true);
  // mismatches
  assert.equal(ok(Buffer.from("<html><script>alert(1)</script>"), PDF), false);
  assert.equal(ok(Buffer.from("<html>"), XLSX_MIME), false);
  assert.equal(ok(Buffer.from("MZ\x90\x00\x03\x00\x00\x00"), CSV), false); // PE header has NULs
  assert.equal(ok(buildPdf([textPage("x")]), XLSX_MIME), false);
  assert.equal(ok(Buffer.from("x"), "image/png"), false);
});

// ============================================================
// 5.2 — rate limiter must survive a blocked event loop at startup
// ============================================================

test("5.2: limiter store init survives a slow SCRIPT LOAD (11th bad login is still 429)", () => {
  // rate-limit-redis fires SCRIPT LOAD once, at construction, and caches a
  // failure forever (=> every limiter silently fails open). Simulate a slow
  // host / blocked event loop by delivering every SCRIPT reply 4s late: past
  // the fail-fast client's 3s commandTimeout, so the old wiring rejects.
  const r = isolated(`
    const { default: IORedis } = await import("ioredis");
    const realSend = IORedis.prototype.sendCommand;
    IORedis.prototype.sendCommand = function (command, stream) {
      if (String(command?.name).toLowerCase() === "script") {
        const resolve = command.resolve;
        command.resolve = (v) => setTimeout(() => resolve(v), 4000);
      }
      return realSend.call(this, command, stream);
    };
    const { loginLimiter } = await import(${JSON.stringify(mod("middlewares/rateLimiter.js"))});
    const { default: express } = await import("express");
    const app = express();
    app.set("trust proxy", true);
    app.post("/login", loginLimiter, (req, res) => res.status(401).end());
    const server = app.listen(0);
    const ip = "203.0.113." + (1 + Math.floor(Math.random() * 250));
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      const r = await fetch("http://127.0.0.1:" + server.address().port + "/login", { method: "POST", headers: { "x-forwarded-for": ip } });
      statuses.push(r.status);
    }
    result = { statuses };
  `, { timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr ?? "", /store initialization/i);
  assert.deepEqual(r.result.statuses.slice(-2), [401, 429], JSON.stringify(r.result.statuses));
});

test("6.6 DB_SSL: verified TLS with a CA bundle, off when unset, never unverified", () => {
  const r = isolated(`
    const { buildSslConfig } = await import(${JSON.stringify(mod("database/db.js"))});
    const out = {};
    out.unset = buildSslConfig({}) ?? null;
    out.off = buildSslConfig({ DB_SSL: "false" }) ?? null;
    const on = buildSslConfig({ DB_SSL: "true" });
    out.on = { strict: on.rejectUnauthorized, hasCa: on.ca.toString().includes("BEGIN CERTIFICATE") };
    try { buildSslConfig({ DB_SSL: "true", DB_SSL_CA: "/nonexistent/ca.pem" }); out.missing = "no throw"; }
    catch (e) { out.missing = e.message; }
    result = out;
  `, { env: { DB_HOST: "127.0.0.1", DB_PORT: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result.unset, null);
  assert.equal(r.result.off, null);
  assert.deepEqual(r.result.on, { strict: true, hasCa: true });
  assert.match(r.result.missing, /CA bundle could not be read/);
});
