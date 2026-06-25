// services/normalizationService.js

/**
 * Normalize raw extracted text for LLM consumption.
 * The goal is consistency, not interpretation.
 */
export function normalizeExtractedText(rawText) {
  let text = rawText;

  // 1. Collapse 3+ blank lines into 2
  text = text.replace(/\n{3,}/g, '\n\n');

  // 2. Normalize time formats to HH:MM
  // Noon/midnight special-cased first — the general +12 conversion below would
  // otherwise turn "12pm" into "00:00" instead of "12:00".
  text = text.replace(/\b12(?::00)?\s*pm\b/gi, '12:00');
  text = text.replace(/\b12(?::00)?\s*am\b/gi, '00:00');
  text = text.replace(/\b(\d{1,2})(am|AM)\b/g, (_, h) => `${h.padStart(2, '0')}:00`);
  text = text.replace(/\b(\d{1,2})(pm|PM)\b/g, (_, h) => `${(parseInt(h) + 12) % 24}:00`);
  text = text.replace(/\b(\d{1,2}):(\d{2})(am|AM)\b/g, (_, h, m) => `${h.padStart(2, '0')}:${m}`);
  text = text.replace(/\b(\d{1,2}):(\d{2})(pm|PM)\b/g, (_, h, m) => `${(parseInt(h) + 12) % 24}:${m}`);
  // "9.30" → "09:30" (dot separator common in Indian timetables). Negative
  // look-around so decimal numbers like "1.50" (a grade/score) aren't touched.
  text = text.replace(/(?<!\d)(\d{1,2})\.(\d{2})(?!\d)/g, (_, h, m) => `${h.padStart(2, '0')}:${m}`);

  // 3. Normalize day abbreviations
  const dayMap = {
    Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday',
    Thu: 'Thursday', Thur: 'Thursday', Fri: 'Friday', Sat: 'Saturday',
  };
  for (const [abbr, full] of Object.entries(dayMap)) {
    text = text.replace(new RegExp(`\\b${abbr}\\b`, 'gi'), full);
  }

  // 4. Normalize duration: "1.5 hrs" / "1½ hrs" → "90 minutes"
  text = text.replace(/(\d+\.?\d*)\s*hr[s]?/gi, (_, n) => `${Math.round(parseFloat(n) * 60)} minutes`);

  // 5. Remove page headers/footers
  text = text.replace(/Page\s+\d+\s+of\s+\d+/gi, '');
  text = text.replace(/^\s*\d+\s*$/gm, ''); // lone page numbers on their own line

  return text.trim();
}

/**
 * Normalize LLM output — coerce field types after LLM returns JSON.
 * Never called at extraction time — only after receiving LLM response.
 */
export function normalizeLlmLecture(raw) {
  const result = {};

  result.teacher_name = raw.teacherName?.trim() || null;
  result.subject = raw.subject?.trim() || null;
  result.room_number = raw.roomNumber?.trim() || null;
  result.batch = raw.batch?.trim() || null;

  // Weekday → integer (1=Mon..7=Sun)
  const DAY_MAP = {
    monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6, sunday: 7,
  };
  const weekdayStr = (raw.weekday || '').toLowerCase().trim();
  result.weekday_number = DAY_MAP[weekdayStr] || null;

  // Start time — must be HH:MM, 24-hour
  const timeStr = raw.startTime;
  if (timeStr) {
    const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (match) {
      const h = parseInt(match[1]);
      const m = parseInt(match[2]);
      result.start_time =
        h >= 0 && h <= 23 && m >= 0 && m <= 59
          ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
          : null;
    } else {
      result.start_time = null;
    }
  } else {
    result.start_time = null;
  }

  // Duration — must be integer between 15 and 300 minutes
  const dur = raw.durationMinutes;
  if (dur !== null && dur !== undefined) {
    const n = parseInt(String(dur));
    result.duration_minutes = !isNaN(n) && n >= 15 && n <= 300 ? n : null;
  } else {
    result.duration_minutes = null;
  }

  // Lecture type
  const lt = (raw.lectureType || '').toUpperCase().trim();
  result.lecture_type = ['CLASSROOM', 'LAB'].includes(lt) ? lt : null;

  // Confidence — Gemini sometimes returns a string ("high") instead of a float (0.9)
  const score = typeof raw.confidence === 'string' ? parseFloat(raw.confidence) || 0 : raw.confidence || 0;
  result.confidence_score = Math.round(score * 100 * 100) / 100;
  if (score >= 0.9) result.confidence = 'HIGH';
  else if (score >= 0.7) result.confidence = 'MEDIUM';
  else result.confidence = 'LOW';

  // Missing fields
  const required = [
    'teacher_name', 'subject', 'room_number', 'weekday_number',
    'start_time', 'duration_minutes',
  ];
  result.missing_fields = required.filter((f) => result[f] === null || result[f] === undefined);

  return result;
}
