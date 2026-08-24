// services/llmService.js
//
// NOTE: the implementation guide originally specified `@google/generative-ai`
// with model `gemini-1.5-flash`. As of this writing both are dead: Google
// shut down all Gemini 1.5 models (404 on every request) and the
// `@google/generative-ai` SDK's support window ended 2025-08-31. This uses
// the current replacements instead — `@google/genai`. `gemini-2.5-pro` was
// tried next but Google cut off new-project access to it (404 on every
// call), so this is now on `gemini-3.1-flash-lite`.
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { IMPORT_CONFIG } from '../config/importConfig.js';
import { isCancelled, updateLlmProgress, markLlmRequestStarted } from './importProgress.js';
import { registerAbortController, unregisterAbortController } from './importAbortRegistry.js';

const GEMINI_MODEL = 'gemini-3.1-flash-lite';
// Without this, a stalled network call (confirmed reproducible: two real
// full-pipeline runs each hung indefinitely at this exact call, one during
// a genuine network blip, one with no external cause at all) never resolves
// or rejects — the retry loop can't retry and the outer isCancelled
// checkpoint (which only runs *between* chunks) is never reached.
const LLM_CALL_TIMEOUT_MS = 45000;
const RETRYABLE_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'];
const RETRYABLE_STATUS = [429, 500, 502, 503, 504];

// Placeholder starting point per the reliability guide's Phase 5 — NOT yet
// calibrated from real p95/p99 chunk-latency data (only a handful of runs
// exist so far, mostly the ones that surfaced the bugs this guide fixes).
// 50 is comfortably above the 36 chunks the one real test file produced.
// Recalibrate once several clean full-pipeline runs exist to observe from.
const ESTIMATED_CHUNKS_PER_FILE = 50;
const DEADLINE_HEADROOM_MULTIPLIER = 1.5;

/**
 * Conservative overall wall-clock budget for a job, derived from file count
 * (the only thing known before any file has been extracted/chunked) rather
 * than actual chunk count. See ESTIMATED_CHUNKS_PER_FILE above.
 */
export function computeJobDeadlineMs(filesTotal) {
  const perFileBudgetMs = ESTIMATED_CHUNKS_PER_FILE * LLM_CALL_TIMEOUT_MS * IMPORT_CONFIG.llmRetryCount;
  return Math.ceil(Math.max(filesTotal, 1) * perFileBudgetMs * DEADLINE_HEADROOM_MULTIPLIER);
}

export function isRetryable(err) {
  if (err.name === 'TimeoutError') return true;
  if (err.name === 'UserCancelledError') return false;
  return RETRYABLE_CODES.includes(err.code) || RETRYABLE_STATUS.includes(err.status);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Runs one Gemini call under a timeout, distinguishing "timed out" from
 * "aborted by an external stop request" — both look like a generic abort to
 * the SDK, but they need opposite handling (timeout → retryable; user
 * cancellation → terminal, never retried, propagates as-is).
 */
export async function callWithTimeout(callFn, { jobId, timeoutMs = LLM_CALL_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('LLM call timeout'));
  }, timeoutMs);

  if (jobId) registerAbortController(jobId, controller);
  try {
    return await callFn(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      const wrapped = new Error(
        timedOut ? `LLM call timed out after ${timeoutMs}ms` : 'LLM call cancelled by user request'
      );
      wrapped.name = timedOut ? 'TimeoutError' : 'UserCancelledError';
      wrapped.cause = err;
      throw wrapped;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (jobId) unregisterAbortController(jobId);
  }
}

/**
 * Retries fn() with exponential backoff + jitter, but only for retryable
 * errors, and never for an intentional user cancellation (that propagates
 * immediately — it must not be retried and must not be miscounted as an
 * ordinary LLM failure).
 */
export async function callWithRetry(fn, { maxAttempts, baseDelayMs = 1000, jobId, chunkIndex, totalChunks } = {}) {
  const label = chunkIndex != null ? `chunk=${chunkIndex} totalChunks=${totalChunks}` : '';
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (jobId) {
      await updateLlmProgress(jobId, { currentChunk: chunkIndex, totalChunks, currentAttempt: attempt, maxAttempts });
      await markLlmRequestStarted(jobId);
    }
    console.log(`[LLM] ${label} attempt=${attempt} started`);
    const startedAt = Date.now();
    try {
      const result = await fn(attempt);
      console.log(`[LLM] ${label} attempt=${attempt} success duration=${Date.now() - startedAt}ms`);
      return result;
    } catch (err) {
      lastError = err;
      const duration = Date.now() - startedAt;
      if (err.name === 'TimeoutError') {
        console.log(`[LLM] ${label} attempt=${attempt} timeout duration=${duration}ms`);
      }
      if (err.name === 'UserCancelledError') throw err;
      if (!isRetryable(err) || attempt === maxAttempts) {
        throw Object.assign(err, { attempts: attempt, retryable: isRetryable(err) });
      }
      const delay = baseDelayMs * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4);
      console.log(`[LLM] ${label} retrying delay=${Math.round(delay)}ms reason=${err.message}`);
      if (jobId) await updateLlmProgress(jobId, { retryIncrement: true });
      await sleep(delay);
    }
  }
  throw lastError;
}

// ─── Prompt ────────────────────────────────────────────────────────────────
const EXTRACTION_PROMPT = `You are processing an academic timetable document from MIT WPU (Maharashtra Institute of Technology, World Peace University), an Indian university.

Extract ALL lecture entries you can find in the text.

For each lecture, return these exact fields:
- teacherName: full name including title (e.g. "Dr. Sharma", "Prof. Mehta", "Ms. Kulkarni")
- subject: full subject or course name (e.g. "Database Management Systems", "Engineering Mathematics III")
- roomNumber: room, lab, or hall number as written (e.g. "VY123", "Lab 3", "Seminar Hall A")
- weekday: full day name (e.g. "Monday", "Tuesday") — never abbreviations
- startTime: 24-hour format HH:MM only (e.g. "09:00", "14:30") — no AM/PM
- durationMinutes: integer minutes only (e.g. 60, 90, 120)
- batch: class or batch identifier as written (e.g. "TE-A", "SE-B", "FY-C", "B-Tech Sem 4")
- lectureType: EXACTLY "CLASSROOM" or "LAB" — nothing else
- confidence: a decimal from 0.0 to 1.0 — how confident you are in THIS specific entry

STRUCTURAL NOTES about this document's formatting:
- Lines starting with "Sheet:" or "Panel:" (or "##PANEL: ...##") are structural
  labels marking which section of the document follows — never extract a
  lecture from these lines themselves.
- A cell written as "[X: content]; [Y: content]" means multiple divisions/
  batches share that same time slot, each with potentially different
  subjects/rooms. Extract ONE separate lecture per bracketed group — use the
  bracket's label (e.g. "X") as that lecture's batch, and the bracket's
  content to determine its subject/room — but all groups in the same cell
  share the same day and start time as the row/column they're in.
- If two adjacent time-slot columns in the same row contain the exact same
  text, that is ONE event spanning both slots (e.g. a 2-hour meeting), not
  two separate lectures — combine them into a single lecture entry whose
  durationMinutes covers the full combined span.

STRICT RULES — violating these makes the output unusable:
1. If a field is not clearly present in the text, set it to null. NEVER guess or fabricate.
2. room_number null is CORRECT if no room is mentioned. Do not invent room numbers.
3. Return ONLY a valid JSON object. No markdown, no explanation, no preamble, no trailing text.
4. If you find zero lectures, return exactly: {"lectures":[]}
5. Confidence < 0.7 means you are uncertain — set uncertain fields to null instead.

Return format (JSON only):
{"lectures":[{"teacherName":...,"subject":...,"roomNumber":...,"weekday":...,"startTime":...,"durationMinutes":...,"batch":...,"lectureType":...,"confidence":...}]}`;

// ─── Provider: Gemini ────────────────────────────────────────────────────────
class GeminiProvider {
  constructor() {
    this.ai = new GoogleGenAI({ apiKey: IMPORT_CONFIG.geminiApiKey });
  }

  async extractLectures(text, signal) {
    const prompt = `${EXTRACTION_PROMPT}\n\nDocument text:\n---\n${text}\n---`;
    const response = await this.ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      // httpOptions.timeout is kept as a second, SDK-internal backstop in
      // case our own AbortController's setTimeout is ever delayed (e.g. by
      // event-loop congestion) — abortSignal is the primary mechanism since
      // we also use it for external stop-requests, which httpOptions.timeout
      // can't do.
      // gemini-3.1-flash-lite uses thinkingLevel (a string enum), not the
      // numeric thinkingBudget older 2.5 models used — MINIMAL is the
      // closest equivalent to "thinking off" this model generation supports.
      // This matters because an unset thinkingLevel silently defaults to
      // "high" on Gemini 3 models — the opposite of what a pure-extraction
      // task needs, and a shorter generation is also what keeps this call
      // clear of real 504s from Google's own gateway timing out
      // mid-generation. maxOutputTokens is capped so a runaway response
      // can't become its own source of latency/timeout.
      config: {
        httpOptions: { timeout: LLM_CALL_TIMEOUT_MS },
        abortSignal: signal,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        maxOutputTokens: 8192,
      },
    });
    return parseAndValidateLlmResponse(response.text);
  }
}

// ─── Response parsing ────────────────────────────────────────────────────────
function parseAndValidateLlmResponse(responseText) {
  // Strip markdown code fences if LLM added them despite instructions
  let cleaned = responseText.trim();
  cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
  cleaned = cleaned.replace(/^```\s*/i, '').replace(/\s*```$/i, '');

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`LLM returned invalid JSON: ${cleaned.slice(0, 200)}`);
  }

  if (!parsed.lectures || !Array.isArray(parsed.lectures)) {
    throw new Error(`LLM response missing "lectures" array: ${cleaned.slice(0, 200)}`);
  }

  return parsed;
}

// ─── Text chunking ────────────────────────────────────────────────────────────
/**
 * Split text into chunks of ~maxChunkSize, accumulating whole "units" (either
 * paragraphs or, if the text has no paragraph breaks at all, single lines)
 * so a unit is never cut mid-way.
 */
function chunkBySize(text, maxChunkSize) {
  if (text.length <= maxChunkSize) return [text];

  const paragraphs = text.split(/\n\n+/);
  // Excel-extracted text is one row per line with no blank-line separators,
  // so the paragraph split above is a no-op (a single giant "paragraph") —
  // fall back to splitting by line in that case.
  const units = paragraphs.length > 1 ? paragraphs : text.split(/\n/);
  const joiner = paragraphs.length > 1 ? '\n\n' : '\n';

  const chunks = [];
  let current = '';
  for (const unit of units) {
    if ((current + unit).length > maxChunkSize && current) {
      chunks.push(current.trim());
      current = unit;
    } else {
      current += (current ? joiner : '') + unit;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

const SHEET_HEADER_PATTERN = /^Sheet: .+$/m;
const PANEL_MARKER_PATTERN = /^##PANEL: .+##$/m;

function chunkBySizeWithPrefix(text, maxChunkSize, prefixLines) {
  const subChunks = chunkBySize(text, maxChunkSize);
  if (subChunks.length <= 1 || prefixLines.length === 0) return subChunks;
  const prefix = prefixLines.join('\n');
  return subChunks.map((chunk, i) => (i === 0 ? chunk : `${prefix}\n${chunk}`));
}

/**
 * Split text into chunks of ~4000 chars to avoid context window limits.
 * Three levels, each hard-splitting before the size-based fallback so a
 * chunk boundary never straddles two sheets or two panels:
 *   1. Excel extraction emits one "Sheet: <name>" marker per sheet.
 *   2. Within a sheet, extractionService.js's parseSheetStructure() emits
 *      one "##PANEL: <label>##" marker per panel (or a "(none)" pseudo-panel
 *      for content before the sheet's first real panel) — splitting here
 *      guarantees a chunk's panel identity is unambiguous, which the
 *      deterministic legend backfill (legendBackfill.js) depends on.
 *   3. Size-chunk within a (sheet, panel) pair if it's still too large,
 *      repeating both the sheet header and a plain "Panel: <label>" line
 *      (not the raw "##" marker, which is internal bookkeeping) on every
 *      resulting sub-chunk after the first.
 * Returns { text, sheetName, panelLabel }[] — panelLabel is null for the
 * "(none)" pseudo-panel and for non-Excel sources (PDF/CSV), which never
 * carry panel markers at all.
 */
export function chunkText(text, maxChunkSize = 4000) {
  const hasSheets = SHEET_HEADER_PATTERN.test(text);
  const sheetSections = hasSheets ? text.split(/(?=^Sheet: )/m).filter((s) => s.trim()) : [text];

  const result = [];
  for (const sheetSection of sheetSections) {
    const sheetMatch = SHEET_HEADER_PATTERN.exec(sheetSection);
    const sheetHeaderLine = sheetMatch ? sheetMatch[0] : null;
    const sheetName = sheetHeaderLine ? sheetHeaderLine.replace(/^Sheet: /, '') : null;
    const afterHeader = sheetHeaderLine
      ? sheetSection.slice(sheetMatch.index + sheetHeaderLine.length).replace(/^\n/, '')
      : sheetSection;

    const hasPanels = PANEL_MARKER_PATTERN.test(afterHeader);
    const panelSections = hasPanels
      ? afterHeader.split(/(?=^##PANEL: )/m).filter((s) => s.trim())
      : [afterHeader];

    for (const panelSection of panelSections) {
      const panelMatch = PANEL_MARKER_PATTERN.exec(panelSection);
      const markerLine = panelMatch ? panelMatch[0] : null;
      const rawLabel = markerLine ? markerLine.replace(/^##PANEL: /, '').replace(/##$/, '') : null;
      const panelLabel = rawLabel === '(none)' ? null : rawLabel;
      const body = markerLine
        ? panelSection.slice(panelMatch.index + markerLine.length).replace(/^\n/, '')
        : panelSection;
      if (!body.trim()) continue;

      const prefixLines = [sheetHeaderLine, panelLabel ? `Panel: ${panelLabel}` : null].filter(Boolean);
      const subChunks = chunkBySizeWithPrefix(body, maxChunkSize, prefixLines);
      for (const chunkTextValue of subChunks) {
        result.push({ text: chunkTextValue, sheetName, panelLabel });
      }
    }
  }
  return result;
}

// ─── Main export ─────────────────────────────────────────────────────────────
let providerInstance = null;

function getProvider() {
  if (providerInstance) return providerInstance;
  if (IMPORT_CONFIG.llmProvider === 'gemini') {
    providerInstance = new GeminiProvider();
  } else {
    throw new Error(`Unknown LLM provider: ${IMPORT_CONFIG.llmProvider}`);
  }
  return providerInstance;
}

/**
 * Extract lectures from text with retry.
 * Returns array of raw lecture objects (before normalization).
 */
export async function extractLecturesFromText(text, jobId = null, { deadlineAt } = {}) {
  const provider = getProvider();
  const chunks = chunkText(text);
  const allLectures = [];
  // Every chunk that exhausts its retries is recorded here (not just the
  // first) — chunkText is kept so a later manual retry (see retryChunk())
  // doesn't need to re-run extraction/chunking from scratch to recover it.
  const failedChunks = [];

  for (let i = 0; i < chunks.length; i++) {
    if (jobId && (await isCancelled(jobId))) break;
    if (deadlineAt && Date.now() > deadlineAt) {
      const deadlineErr = new Error(
        `Job deadline exceeded before chunk ${i + 1}/${chunks.length} (budget: ${new Date(deadlineAt).toISOString()})`
      );
      deadlineErr.name = 'DeadlineExceededError';
      throw deadlineErr;
    }
    const chunk = chunks[i];
    const chunkNum = i + 1;
    try {
      const result = await callWithRetry(
        () => callWithTimeout((signal) => provider.extractLectures(chunk.text, signal), { jobId }),
        { maxAttempts: IMPORT_CONFIG.llmRetryCount, jobId, chunkIndex: chunkNum, totalChunks: chunks.length }
      );
      // Tag each lecture with the chunk's panel/sheet identity — set by
      // chunkText()'s panel-level hard split, so a later deterministic pass
      // (legendBackfill.js) knows which panel's Theory/Lab legend to look
      // the lecture's subject code up against.
      for (const lecture of result.lectures) {
        lecture._panelLabel = chunk.panelLabel;
        lecture._sheetName = chunk.sheetName;
      }
      allLectures.push(...result.lectures);
      console.log(`[IMPORT] chunk=${chunkNum}/${chunks.length} completed`);
    } catch (err) {
      if (err.name === 'UserCancelledError') {
        // Propagate immediately — the worker must transition the job to
        // CANCELLED, not treat this as an ordinary LLM failure to log and
        // continue past.
        console.log(`[IMPORT] job=${jobId} cancelled reason="${err.message}"`);
        throw err;
      }
      console.error(
        `[LLM] chunk=${chunkNum}/${chunks.length} failed after ${err.attempts ?? IMPORT_CONFIG.llmRetryCount} attempt(s):`,
        err.message
      );
      // A chunk that exhausts its retries doesn't abort the whole document —
      // the other chunks may still extract usable lectures. Only surfaced as
      // a hard failure below if nothing came out of any chunk.
      failedChunks.push({
        chunkIndex: chunkNum,
        totalChunks: chunks.length,
        errorMessage: err.message,
        chunkText: chunk.text,
        panelLabel: chunk.panelLabel,
        sheetName: chunk.sheetName,
      });
    }
  }

  // Deliberately does NOT throw when allLectures is empty but failedChunks
  // isn't — the caller (importPipelineWorker.js) needs failedChunks even in
  // the total-failure case to persist them for the retry endpoint and the
  // review-UI banner. Throwing here (the original pre-chunk-tracking
  // behavior) would discard that array entirely and silently defeat the
  // whole point of tracking failed chunks in the first place — confirmed
  // live during this feature's own verification run, where a real Gemini
  // 504 outage failed all 15/15 chunks and this exact path was hit.
  return { lectures: allLectures, failedChunks };
}

/**
 * Re-run a single previously-failed chunk through the same call path
 * (timeout + bounded retry) `extractLecturesFromText`'s main loop uses —
 * added so `POST /jobs/:jobId/files/:fileId/retry-failed-chunks` can reuse
 * the existing mechanism instead of duplicating it. Does not touch or
 * re-enter the main extraction loop.
 */
export async function retryChunk(chunkText, jobId, { chunkIndex, totalChunks, maxAttempts = IMPORT_CONFIG.llmRetryCount } = {}) {
  const provider = getProvider();
  const result = await callWithRetry(
    () => callWithTimeout((signal) => provider.extractLectures(chunkText, signal), { jobId }),
    { maxAttempts, jobId, chunkIndex, totalChunks }
  );
  return result.lectures;
}

export const GEMINI_MODEL_NAME = GEMINI_MODEL;
