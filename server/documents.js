// Server-side text extraction for Word and PDF uploads (build spec §44; blueprint §10.4, §16).
// Word: mammoth (raw text only). PDF: Mozilla's pdf.js, legacy build for Node. Both are imported
// dynamically, so the server still starts if either is missing. Nothing here logs or returns content
// except the extracted text itself, which callers must treat as learner data.
import { createRequire } from 'node:module';
import path from 'node:path';
import { INBOX_MAX_BYTES } from './storage/inbox.js';

export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PDF_TYPE = 'application/pdf';
export const DOCUMENT_TYPES = Object.freeze([DOCX_TYPE, PDF_TYPE]);

// Same ceiling as the inbox, so anything the Worker accepts can be read.
export const MAX_DOCUMENT_BYTES = INBOX_MAX_BYTES;
// Briefs and drafts are short; a long PDF is read up to this many pages and marked truncated.
export const MAX_PAGES = 40;
export const MAX_TEXT_CHARS = 100_000;
export const EXTRACT_TIMEOUT_MS = 20_000;
// A-003: a PDF counts as a scan when it has almost no text. Measured as non-space characters per page
// read, so a scan with a printed page number or footer still counts as a scan.
export const SCANNED_CHARS_PER_PAGE = 40;
// Pages below this in an otherwise readable PDF are reported, so WP-107 can flag them as uncertain.
export const LOW_TEXT_PAGE_CHARS = 10;

export const EXTRACT_REASONS = Object.freeze([
  'unsupported-type', 'too-large', 'empty', 'not-installed', 'unreadable', 'password', 'timeout',
]);

const MAMMOTH_PACKAGE = 'mammoth';
const PDFJS_PACKAGE = 'pdfjs-dist';
// VERIFY: the legacy build's entry point in the installed pdfjs-dist is legacy/build/pdf.mjs.
const PDFJS_ENTRY = 'pdfjs-dist/legacy/build/pdf.mjs';

/** Removes control characters (keeping tabs and line breaks), tidies spaces and blank lines. */
export function cleanText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Non-space characters, used for the scan check. */
export function textChars(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, '').length : 0;
}

/** Joins pdf.js text items into lines. Items without `str` are layout markers and are skipped. */
export function joinTextItems(items) {
  let out = '';
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.str !== 'string') continue;
    if (out && !out.endsWith('\n') && !out.endsWith(' ') && item.str && !item.str.startsWith(' ')) out += ' ';
    out += item.str;
    if (item.hasEOL) out += '\n';
  }
  return out;
}

/** A-003 decision from per-page character counts. */
export function judgePages(pageChars) {
  const counts = Array.isArray(pageChars) ? pageChars : [];
  const total = counts.reduce((sum, n) => sum + n, 0);
  const average = counts.length ? total / counts.length : 0;
  const scanned = average < SCANNED_CHARS_PER_PAGE;
  const lowTextPages = scanned ? [] : counts.flatMap((n, i) => (n < LOW_TEXT_PAGE_CHARS ? [i + 1] : []));
  return { scanned, lowTextPages, totalChars: total };
}

// Reasons come from error names only, never messages, which can quote the document.
function reasonFor(err) {
  if (err?.reason && EXTRACT_REASONS.includes(err.reason)) return err.reason;
  if (err?.name === 'PasswordException') return 'password';
  return 'unreadable';
}

function fail(kind, reason, ms = 0) {
  return { ok: false, kind, reason, ms };
}

function capText(text) {
  if (text.length <= MAX_TEXT_CHARS) return { text, cut: false };
  return { text: text.slice(0, MAX_TEXT_CHARS), cut: true };
}

/** Rejects after `ms`, calling onTimeout first so the work can be cancelled. */
function withTimeout(promise, ms, onTimeout) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // cancelling is best effort
      }
      reject(Object.assign(new Error('timed out'), { reason: 'timeout' }));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---- library adapters (the only code that touches mammoth or pdf.js) ----

/** Loads mammoth. Returns { lib } or { error }. */
export async function loadMammoth(importer = (name) => import(name)) {
  try {
    const mod = await importer(MAMMOTH_PACKAGE);
    // VERIFY: mammoth 1.13.0 is CommonJS, so its functions arrive on the default export.
    const lib = mod?.extractRawText ? mod : mod?.default;
    if (typeof lib?.extractRawText !== 'function') return { error: 'mammoth has no extractRawText' };
    return { lib };
  } catch (err) {
    return { error: `${MAMMOTH_PACKAGE} not available (${err?.code ?? err?.name ?? 'error'})` };
  }
}

/** Loads pdf.js and finds its font folders. Returns { lib, fontDir, cmapDir } or { error }. */
export async function loadPdfjs(importer = (name) => import(name), resolver = defaultResolver) {
  try {
    const lib = await importer(PDFJS_ENTRY);
    if (typeof lib?.getDocument !== 'function') return { error: 'pdf.js has no getDocument' };
    let fontDir = null;
    let cmapDir = null;
    try {
      // VERIFY: pdfjs-dist ships standard_fonts/ and cmaps/ beside package.json.
      const root = path.dirname(resolver(`${PDFJS_PACKAGE}/package.json`));
      fontDir = path.join(root, 'standard_fonts') + path.sep;
      cmapDir = path.join(root, 'cmaps') + path.sep;
    } catch {
      // text extraction still works for most PDFs without them
    }
    return { lib, fontDir, cmapDir };
  } catch (err) {
    return { error: `${PDFJS_PACKAGE} not available (${err?.code ?? err?.name ?? 'error'})` };
  }
}

function defaultResolver(specifier) {
  return createRequire(import.meta.url).resolve(specifier);
}

async function readDocx(lib, bytes) {
  // VERIFY: extractRawText({ buffer }) takes a Node Buffer and resolves { value, messages }.
  const result = await lib.extractRawText({ buffer: Buffer.from(bytes) });
  return { text: typeof result?.value === 'string' ? result.value : '', warnings: Array.isArray(result?.messages) ? result.messages.length : 0 };
}

function pdfOptions(loaded, bytes) {
  // VERIFY: these getDocument options exist in pdfjs-dist 6.4.299.
  return {
    data: new Uint8Array(bytes),
    isEvalSupported: false, // never compile code found inside an uploaded file
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
    ...(loaded.fontDir ? { standardFontDataUrl: loaded.fontDir } : {}),
    ...(loaded.cmapDir ? { cMapUrl: loaded.cmapDir, cMapPacked: true } : {}),
  };
}

async function readPdf(loaded, bytes, { maxPages, onTask }) {
  const task = loaded.lib.getDocument(pdfOptions(loaded, bytes));
  onTask?.(task);
  const doc = await task.promise;
  const pageCount = doc.numPages;
  const readCount = Math.min(pageCount, maxPages);
  const pages = [];
  for (let n = 1; n <= readCount; n += 1) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(cleanText(joinTextItems(content?.items)));
    page.cleanup?.();
  }
  return { pageCount, pages };
}

// ---- public entry point ----

/**
 * Extracts text from one Word or PDF file held in memory.
 * Returns { ok: true, kind, text, pageCount, pagesRead, pageChars, scanned, lowTextPages, truncated, warnings, ms }
 * or { ok: false, kind, reason, ms } where reason is one of EXTRACT_REASONS.
 * A scanned PDF is ok with scanned: true and text '' — the caller applies A-003.
 */
export async function extractDocument({
  bytes, mimeType, timeoutMs = EXTRACT_TIMEOUT_MS, maxPages = MAX_PAGES,
  loaders = {}, clock = () => Date.now(),
}) {
  const started = clock();
  const elapsed = () => clock() - started;
  const kind = mimeType === DOCX_TYPE ? 'docx' : mimeType === PDF_TYPE ? 'pdf' : null;
  if (!kind) return fail(null, 'unsupported-type');
  const size = bytes?.byteLength ?? bytes?.length ?? 0;
  if (!size) return fail(kind, 'empty');
  if (size > MAX_DOCUMENT_BYTES) return fail(kind, 'too-large');

  if (kind === 'docx') {
    const loaded = await (loaders.mammoth ?? loadMammoth)();
    if (loaded.error) return fail(kind, 'not-installed', elapsed());
    try {
      const raw = await withTimeout(readDocx(loaded.lib, bytes), timeoutMs);
      const capped = capText(cleanText(raw.text));
      return {
        ok: true, kind, text: capped.text, pageCount: null, pagesRead: null, pageChars: null,
        scanned: false, lowTextPages: [], truncated: capped.cut, warnings: raw.warnings, ms: elapsed(),
      };
    } catch (err) {
      return fail(kind, reasonFor(err), elapsed());
    }
  }

  const loaded = await (loaders.pdfjs ?? loadPdfjs)();
  if (loaded.error) return fail(kind, 'not-installed', elapsed());
  let task = null;
  try {
    const result = await withTimeout(
      readPdf(loaded, bytes, { maxPages, onTask: (t) => { task = t; } }),
      timeoutMs,
      () => task?.destroy?.(),
    );
    const pageChars = result.pages.map(textChars);
    const judged = judgePages(pageChars);
    const joined = judged.scanned ? '' : result.pages.join('\n\n');
    const capped = capText(joined);
    return {
      ok: true, kind, text: capped.text, pageCount: result.pageCount, pagesRead: result.pages.length,
      pageChars, scanned: judged.scanned, lowTextPages: judged.lowTextPages,
      truncated: capped.cut || result.pages.length < result.pageCount, warnings: 0, ms: elapsed(),
    };
  } catch (err) {
    return fail(kind, reasonFor(err), elapsed());
  } finally {
    // release pdf.js memory after every file; the server is long-running
    try {
      await task?.destroy?.();
    } catch {
      // already destroyed
    }
  }
}
