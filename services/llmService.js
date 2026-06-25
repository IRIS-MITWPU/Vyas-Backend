// services/llmService.js
//
// NOTE: the implementation guide originally specified `@google/generative-ai`
// with model `gemini-1.5-flash`. As of this writing both are dead: Google
// shut down all Gemini 1.5 models (404 on every request) and the
// `@google/generative-ai` SDK's support window ended 2025-08-31. This uses
// the current replacements instead — `@google/genai` + `gemini-2.5-flash`.
import { GoogleGenAI } from '@google/genai';
import { IMPORT_CONFIG } from '../config/importConfig.js';

const GEMINI_MODEL = 'gemini-2.5-flash';

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

  async extractLectures(text) {
    const prompt = `${EXTRACTION_PROMPT}\n\nDocument text:\n---\n${text}\n---`;
    const response = await this.ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
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
 * Split text into chunks of ~4000 chars to avoid context window limits.
 * Split on double newlines (paragraph breaks) to avoid cutting mid-sentence.
 */
export function chunkText(text, maxChunkSize = 4000) {
  if (text.length <= maxChunkSize) return [text];

  const chunks = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';

  for (const para of paragraphs) {
    if ((current + para).length > maxChunkSize && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
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
export async function extractLecturesFromText(text) {
  const provider = getProvider();
  const chunks = chunkText(text);
  const allLectures = [];
  let firstChunkError = null;

  for (const chunk of chunks) {
    let lastError;
    for (let attempt = 1; attempt <= IMPORT_CONFIG.llmRetryCount; attempt++) {
      try {
        const result = await provider.extractLectures(chunk);
        allLectures.push(...result.lectures);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        console.error(`[LLM] Attempt ${attempt} failed:`, err.message);
        if (attempt < IMPORT_CONFIG.llmRetryCount) {
          await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
        }
      }
    }
    // A chunk that exhausts its retries doesn't abort the whole document —
    // the other chunks may still extract usable lectures. Only surfaced as
    // a hard failure below if nothing came out of any chunk.
    if (lastError) firstChunkError = firstChunkError || lastError;
  }

  if (allLectures.length === 0 && firstChunkError) {
    throw new Error(`LLM extraction failed after ${IMPORT_CONFIG.llmRetryCount} attempts: ${firstChunkError.message}`);
  }

  return allLectures;
}

export const GEMINI_MODEL_NAME = GEMINI_MODEL;
