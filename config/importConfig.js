// config/importConfig.js
// Split out from app.js to avoid a circular import: routes/timetable-import.js
// needs this config, and app.js imports that router.

export const IMPORT_CONFIG = {
  uploadDir: process.env.IMPORT_UPLOAD_DIR || './uploads/timetable-imports',
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
};

if (!IMPORT_CONFIG.geminiApiKey) {
  console.warn('[TimetableImport] WARNING: GEMINI_API_KEY not set — LLM extraction will fail');
}
