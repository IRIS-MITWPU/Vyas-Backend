// config/importConfig.js
// Split out from app.js to avoid a circular import: routes/timetable-import.js
// needs this config, and app.js imports that router.

export const IMPORT_CONFIG = {
  s3Bucket: process.env.S3_BUCKET,
  ocrTextThreshold: parseInt(process.env.OCR_TEXT_THRESHOLD || '100'),
  llmRetryCount: parseInt(process.env.LLM_RETRY_COUNT || '3'),
  llmProvider: process.env.LLM_PROVIDER || 'gemini',
  geminiApiKey: process.env.GEMINI_API_KEY,
  maxFileSizeMb: 50,
  allowedMimeTypes: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'application/vnd.ms-excel',
  ],
  // Off by default — the single-letter codes (R/C/E/S) found at short
  // break-time-column positions in real sample files have no discoverable
  // legend defining their meaning, only a consistent position. Enable only
  // once that's been confirmed against more real files.
  stripBreakColumns: process.env.STRIP_BREAK_COLUMNS === 'true',
  breakColumnMaxDurationMinutes: parseInt(process.env.BREAK_COLUMN_MAX_DURATION_MINUTES || '20'),
  legendFuzzyMatchThreshold: parseFloat(process.env.LEGEND_FUZZY_MATCH_THRESHOLD || '0.8'),
};

if (!IMPORT_CONFIG.geminiApiKey) {
  console.warn('[TimetableImport] WARNING: GEMINI_API_KEY not set — LLM extraction will fail');
}
