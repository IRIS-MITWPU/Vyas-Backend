// services/ocrService.js
import Tesseract from 'tesseract.js';
import fs from 'fs/promises';

/**
 * OCR a scanned PDF/image. Returns extracted text string.
 * Uses tesseract.js, which runs entirely in Node — no native binary needed.
 */
export async function ocrPdf(filePath) {
  const buffer = await fs.readFile(filePath);

  const worker = await Tesseract.createWorker('eng');
  try {
    const { data: { text } } = await worker.recognize(buffer);
    return text;
  } finally {
    await worker.terminate();
  }
}
