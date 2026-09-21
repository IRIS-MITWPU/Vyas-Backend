// utils/fileSniff.js — content check for uploads: does the file's leading
// bytes agree with the declared MIME type? (The MIME type and extension are
// client-supplied; this is what stops e.g. an HTML/exe renamed to .xlsx.)
const startsWith = (head, bytes) => bytes.every((b, i) => head[i] === b);
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP = [0x50, 0x4b, 0x03, 0x04]; // xlsx is a zip
const OLE = [0xd0, 0xcf, 0x11, 0xe0]; // legacy .xls
// CSV has no signature: accept anything that looks like text (no NUL bytes).
const looksLikeText = (head) => !head.includes(0);

export function contentMatchesMime(head, mime) {
  switch (mime) {
    case 'application/pdf':
      return startsWith(head, PDF);
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return startsWith(head, ZIP);
    case 'text/csv':
      return looksLikeText(head);
    case 'application/vnd.ms-excel': // Windows browsers also send .csv as this
      return startsWith(head, OLE) || looksLikeText(head);
    default:
      return false;
  }
}
