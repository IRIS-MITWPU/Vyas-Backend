// services/legendBackfill.js
//
// Deterministic (non-LLM) post-extraction pass: for lectures with a null
// teacher_name and/or an unresolved bare subject code, look up
// (panel, subject_code) in that panel's own Theory/Lab legend (parsed by
// timetableStructureParser.js) and fill in the resolved subject name/
// teacher/room. Runs once, after ALL chunks/files for a job have finished —
// this is a plain lookup/join, not a reasoning task, so it stays out of the
// LLM entirely. Reuses normalizeLlmLecture() (not a fork) to recompute
// missing_fields/confidence/confidence_score after the join so the review
// queue reflects the post-backfill state.
import stringSimilarity from 'string-similarity';
import { normalizeLlmLecture } from './normalizationService.js';
import { normalizeCode } from './timetableStructureParser.js';
import { IMPORT_CONFIG } from '../config/importConfig.js';

/**
 * Finds the PanelInfo a saved lecture row belongs to, matching on the
 * (sheet_name, panel_label) pair stamped onto it at extraction time (see
 * llmService.js's extractLecturesFromText / lectureStorage.js).
 */
export function findLegendMatch(lecture, panels) {
  return (
    panels.find(
      (p) => (p.sheetName ?? null) === (lecture.sheet_name ?? null) && (p.panelLabel ?? null) === (lecture.panel_label ?? null)
    ) || null
  );
}

/**
 * Pure. Tries to resolve a lecture's teacher/subject/room against one
 * panel's legend lookups — exact normalized-code match first, then a
 * string-similarity fallback (e.g. "DS-I" vs "Data structures I") against
 * the legend's full subject names. Never overwrites an already-present,
 * non-code-like subject/teacher/room — only fills nulls, or replaces a
 * subject that's literally just the bare code the LLM copied verbatim.
 */
export function resolveMissingFieldsFromLegend(lecture, panelInfo, threshold = IMPORT_CONFIG.legendFuzzyMatchThreshold) {
  if (!panelInfo || panelInfo.subjectLookup.size === 0) return { changed: false };

  const candidateRaw = (lecture.subject || lecture.raw_subject || '').trim();
  if (!candidateRaw) return { changed: false };

  const exactKey = normalizeCode(candidateRaw);
  let matchedCode = panelInfo.subjectLookup.has(exactKey) ? exactKey : null;
  const matchType = matchedCode ? 'exact' : null;

  let bestScore = 0;
  if (!matchedCode) {
    for (const [code, entry] of panelInfo.subjectLookup) {
      const score = stringSimilarity.compareTwoStrings(candidateRaw.toLowerCase(), entry.subjectName.toLowerCase());
      if (score > bestScore) {
        bestScore = score;
        matchedCode = code;
      }
    }
    if (bestScore < threshold) matchedCode = null;
  }
  if (!matchedCode) return { changed: false };

  const isExact = matchType === 'exact';
  const subjectEntry = panelInfo.subjectLookup.get(matchedCode);
  const labEntry = panelInfo.labLookup.get(matchedCode);
  const result = { changed: false, matchType: isExact ? 'exact' : 'fuzzy' };

  if (!lecture.teacher_name && subjectEntry.teacher) {
    result.teacherName = subjectEntry.teacher;
    result.changed = true;
  }
  // Only replace subject when it's currently null, or when what's there is
  // literally just the bare code we matched on (e.g. "CN") — never
  // overwrite a genuine, already-resolved longer subject name.
  if (subjectEntry.subjectName && (!lecture.subject || isExact)) {
    result.subject = subjectEntry.subjectName;
    result.changed = true;
  }
  if (!lecture.room_number && labEntry?.room) {
    result.roomNumber = labEntry.room;
    result.changed = true;
  }
  return result;
}

/**
 * Runs the backfill over a batch of already-saved lecture rows, updating
 * both the DB and the in-memory objects (so downstream correlation/conflict
 * detection in the same job run sees the resolved values). Returns counts
 * for the caller to log — auditable, not a silent black box.
 */
export async function backfillLecturesFromLegend(lectures, panels, pool, options = {}) {
  const threshold = options.legendFuzzyMatchThreshold ?? IMPORT_CONFIG.legendFuzzyMatchThreshold;
  let exactCount = 0;
  let fuzzyCount = 0;

  for (const lecture of lectures) {
    if (lecture.teacher_name && lecture.subject && lecture.room_number) continue;

    const panelInfo = findLegendMatch(lecture, panels);
    if (!panelInfo) continue;

    const resolved = resolveMissingFieldsFromLegend(lecture, panelInfo, threshold);
    if (!resolved.changed) continue;

    // Reconstruct the original raw-LLM shape from the already-stored raw_*
    // columns (never mutated since insert) plus the original confidence
    // float from llm_raw_response, substitute the resolved fields, and
    // reuse normalizeLlmLecture() unchanged — the backfilled row keeps the
    // LLM's original confidence rather than manufacturing new certainty;
    // legend_backfilled is the auditable signal a field was code-resolved.
    const rawShape = {
      teacherName: resolved.teacherName ?? lecture.raw_teacher_name,
      subject: resolved.subject ?? lecture.raw_subject,
      roomNumber: resolved.roomNumber ?? lecture.raw_room_number,
      weekday: lecture.raw_weekday,
      startTime: lecture.raw_start_time,
      durationMinutes: lecture.raw_duration_minutes,
      batch: lecture.raw_batch,
      lectureType: lecture.raw_lecture_type,
      confidence: lecture.llm_raw_response?.confidence,
    };
    const normalized = normalizeLlmLecture(rawShape);

    await pool.query(
      `UPDATE timetable_extracted_lectures
       SET teacher_name = $1, subject = $2, room_number = $3,
           confidence = $4, confidence_score = $5, missing_fields = $6,
           legend_backfilled = TRUE, updated_at = NOW()
       WHERE id = $7`,
      [
        normalized.teacher_name, normalized.subject, normalized.room_number,
        normalized.confidence, normalized.confidence_score, normalized.missing_fields,
        lecture.id,
      ]
    );

    lecture.teacher_name = normalized.teacher_name;
    lecture.subject = normalized.subject;
    lecture.room_number = normalized.room_number;
    lecture.confidence = normalized.confidence;
    lecture.confidence_score = normalized.confidence_score;
    lecture.missing_fields = normalized.missing_fields;
    lecture.legend_backfilled = true;

    if (resolved.matchType === 'exact') exactCount++;
    else fuzzyCount++;
  }

  const backfilledCount = exactCount + fuzzyCount;
  console.log(`[LegendBackfill] Backfilled ${backfilledCount}/${lectures.length} lecture(s) (exact=${exactCount}, fuzzy=${fuzzyCount})`);
  return { backfilledCount, exactCount, fuzzyCount };
}
