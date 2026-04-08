import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const PDF_DOWNLOAD_TIMEOUT_MS = 15000;
const PDF_PARSE_TIMEOUT_MS = 10000;
const MAX_PDF_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB — skip huge files
const MAX_PDF_TEXT_CHARS = 20000;

/**
 * Download a PDF from a URL and extract its text content.
 * Returns empty string on any failure (network, parse, timeout, oversize).
 */
export async function extractPdfText(url) {
  if (!url || !/^https?:\/\//i.test(url)) return '';

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PDF_DOWNLOAD_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    clearTimeout(timer);

    if (!response.ok) return '';

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('pdf') && !url.toLowerCase().endsWith('.pdf')) return '';

    // Skip oversized PDFs early via Content-Length header
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_PDF_SIZE_BYTES) {
      console.log(`[PDF] Skipping oversized PDF (${Math.round(contentLength / 1024 / 1024)}MB): ${url}`);
      return '';
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // Double-check actual size (Content-Length can be missing/wrong)
    if (buffer.length > MAX_PDF_SIZE_BYTES) {
      console.log(`[PDF] Skipping oversized PDF (${Math.round(buffer.length / 1024 / 1024)}MB): ${url}`);
      return '';
    }

    // Parse with timeout to prevent hangs on malformed PDFs
    const result = await Promise.race([
      pdfParse(buffer),
      new Promise((_, reject) => setTimeout(() => reject(new Error('PDF parse timeout')), PDF_PARSE_TIMEOUT_MS))
    ]);
    return (result.text || '').slice(0, MAX_PDF_TEXT_CHARS);
  } catch {
    return '';
  }
}
