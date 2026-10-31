import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCX_TYPE, PDF_TYPE, MAX_DOCUMENT_BYTES, MAX_PAGES, MAX_TEXT_CHARS, SCANNED_CHARS_PER_PAGE,
  cleanText, textChars, joinTextItems, judgePages, extractDocument, loadMammoth, loadPdfjs,
} from '../server/documents.js';
import { INBOX_MAX_BYTES } from '../server/storage/inbox.js';
import { crc32, makeDocx, makePdf } from '../scripts/make-documents.js';
import {
  CHECKS, MARKERS, LONG_PAGES, parseArgs, typeForFile, judge, summary, runSpike, formatReport,
} from '../scripts/spike-documents.js';

// ---- fakes ----
function fakeMammoth(value = 'Para one\n\nPara two', { calls = [], fail = null } = {}) {
  return async () => ({
    lib: {
      async extractRawText(input) {
        calls.push(input);
        if (fail) throw fail;
        return { value, messages: [{ type: 'warning' }] };
      },
    },
  });
}

function fakePdfjs(pages, { numPages = pages.length, fail = null, hang = false, state = {} } = {}) {
  state.destroyed = 0;
  state.read = 0;
  state.options = null;
  return async () => ({
    fontDir: '/fonts/',
    cmapDir: null,
    lib: {
      getDocument(options) {
        state.options = options;
        const promise = hang
          ? new Promise(() => {})
          : fail
            ? Promise.reject(fail)
            : Promise.resolve({
              numPages,
              async getPage(n) {
                state.read += 1;
                return { async getTextContent() { return { items: pages[n - 1] ?? [] }; }, cleanup() {} };
              },
            });
        return { promise, async destroy() { state.destroyed += 1; } };
      },
    },
  });
}

const words = (s) => [{ str: s, hasEOL: true }];
const longLine = 'This invented page holds plenty of ordinary readable text for the check.';

// ---- helpers ----
test('cleanText removes control characters and tidies spacing', () => {
  assert.equal(cleanText('  a\u0000b \t c\r\n\n\n\nd  '), 'ab c\n\nd');
  assert.equal(cleanText(null), '');
});

test('textChars counts non-space characters', () => {
  assert.equal(textChars(' a b\nc '), 3);
  assert.equal(textChars(undefined), 0);
});

test('joinTextItems skips layout markers and keeps line ends', () => {
  const text = joinTextItems([{ str: 'Hello', hasEOL: false }, { type: 'beginMarkedContent' }, { str: 'world', hasEOL: true }, { str: 'Next' }]);
  assert.equal(text, 'Hello world\nNext');
});

test('judgePages: almost no text is a scan; low pages listed only for readable PDFs', () => {
  assert.equal(judgePages([0, 0]).scanned, true);
  assert.equal(judgePages([3, 2, 4]).scanned, true); // page numbers only
  assert.equal(judgePages([]).scanned, true);
  const mixed = judgePages([500, 0, 400]);
  assert.equal(mixed.scanned, false);
  assert.deepEqual(mixed.lowTextPages, [2]);
  assert.equal(judgePages([SCANNED_CHARS_PER_PAGE]).scanned, false);
});

test('document limit matches the inbox limit', () => {
  assert.equal(MAX_DOCUMENT_BYTES, INBOX_MAX_BYTES);
});

// ---- extractDocument ----
test('rejects unsupported types, empty and oversized files before loading anything', async () => {
  let loaded = false;
  const loaders = { pdfjs: async () => { loaded = true; return { error: 'x' }; } };
  assert.equal((await extractDocument({ bytes: Buffer.from('x'), mimeType: 'image/png', loaders })).reason, 'unsupported-type');
  assert.equal((await extractDocument({ bytes: Buffer.alloc(0), mimeType: PDF_TYPE, loaders })).reason, 'empty');
  const big = { byteLength: MAX_DOCUMENT_BYTES + 1 };
  assert.equal((await extractDocument({ bytes: big, mimeType: PDF_TYPE, loaders })).reason, 'too-large');
  assert.equal(loaded, false);
});

test('docx: passes a Buffer to mammoth and returns cleaned text', async () => {
  const calls = [];
  const r = await extractDocument({ bytes: new Uint8Array([1, 2, 3]), mimeType: DOCX_TYPE, loaders: { mammoth: fakeMammoth('A\n\n\n\nB', { calls }) } });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'docx');
  assert.equal(r.text, 'A\n\nB');
  assert.equal(r.warnings, 1);
  assert.equal(r.scanned, false);
  assert.ok(Buffer.isBuffer(calls[0].buffer));
});

test('docx: very long text is capped and marked truncated', async () => {
  const r = await extractDocument({ bytes: Buffer.from('x'), mimeType: DOCX_TYPE, loaders: { mammoth: fakeMammoth('a'.repeat(MAX_TEXT_CHARS + 50)) } });
  assert.equal(r.text.length, MAX_TEXT_CHARS);
  assert.equal(r.truncated, true);
});

test('missing library gives not-installed, and a library error gives unreadable without its message', async () => {
  const missing = await extractDocument({ bytes: Buffer.from('x'), mimeType: DOCX_TYPE, loaders: { mammoth: async () => ({ error: 'gone' }) } });
  assert.equal(missing.reason, 'not-installed');
  const broken = await extractDocument({
    bytes: Buffer.from('x'), mimeType: DOCX_TYPE,
    loaders: { mammoth: fakeMammoth('', { fail: new Error('secret words from the document') }) },
  });
  assert.deepEqual(Object.keys(broken).sort(), ['kind', 'ms', 'ok', 'reason']);
  assert.equal(broken.reason, 'unreadable');
});

test('pdf: reads every page, joins text, sets safe options and releases memory', async () => {
  const state = {};
  const pages = [words(longLine), words(`${longLine} Two.`)];
  const r = await extractDocument({ bytes: Buffer.from('%PDF'), mimeType: PDF_TYPE, loaders: { pdfjs: fakePdfjs(pages, { state }) } });
  assert.equal(r.ok, true);
  assert.equal(r.pageCount, 2);
  assert.equal(r.pagesRead, 2);
  assert.equal(r.scanned, false);
  assert.ok(r.text.includes('Two.'));
  assert.equal(r.pageChars.length, 2);
  assert.equal(state.options.isEvalSupported, false);
  assert.ok(state.options.data instanceof Uint8Array);
  assert.equal(state.options.standardFontDataUrl, '/fonts/');
  assert.equal('cMapUrl' in state.options, false);
  assert.equal(state.destroyed, 1);
});

test('pdf: a picture-only PDF is a scan with no text', async () => {
  const r = await extractDocument({ bytes: Buffer.from('%PDF'), mimeType: PDF_TYPE, loaders: { pdfjs: fakePdfjs([[], words('3')]) } });
  assert.equal(r.ok, true);
  assert.equal(r.scanned, true);
  assert.equal(r.text, '');
  assert.deepEqual(r.lowTextPages, []);
});

test('pdf: long files stop at the page limit and are marked truncated', async () => {
  const state = {};
  const pages = Array.from({ length: MAX_PAGES + 5 }, () => words(longLine));
  const r = await extractDocument({ bytes: Buffer.from('%PDF'), mimeType: PDF_TYPE, loaders: { pdfjs: fakePdfjs(pages, { state }) } });
  assert.equal(r.pageCount, MAX_PAGES + 5);
  assert.equal(r.pagesRead, MAX_PAGES);
  assert.equal(state.read, MAX_PAGES);
  assert.equal(r.truncated, true);
});

test('pdf: password-protected and damaged files give clear reasons', async () => {
  const pw = Object.assign(new Error('x'), { name: 'PasswordException' });
  const a = await extractDocument({ bytes: Buffer.from('%PDF'), mimeType: PDF_TYPE, loaders: { pdfjs: fakePdfjs([], { fail: pw }) } });
  assert.equal(a.reason, 'password');
  const bad = Object.assign(new Error('x'), { name: 'InvalidPDFException' });
  const b = await extractDocument({ bytes: Buffer.from('%PDF'), mimeType: PDF_TYPE, loaders: { pdfjs: fakePdfjs([], { fail: bad }) } });
  assert.equal(b.reason, 'unreadable');
});

test('pdf: a file that never finishes times out and is destroyed', async () => {
  const state = {};
  const r = await extractDocument({ bytes: Buffer.from('%PDF'), mimeType: PDF_TYPE, timeoutMs: 20, loaders: { pdfjs: fakePdfjs([], { hang: true, state }) } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timeout');
  assert.ok(state.destroyed >= 1);
});

test('loaders report a missing package instead of throwing', async () => {
  const m = await loadMammoth(async () => { throw Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' }); });
  assert.match(m.error, /ERR_MODULE_NOT_FOUND/);
  const p = await loadPdfjs(async () => { throw new Error('x'); });
  assert.ok(p.error);
  const viaDefault = await loadMammoth(async () => ({ default: { extractRawText: () => {} } }));
  assert.equal(typeof viaDefault.lib.extractRawText, 'function');
  const pdf = await loadPdfjs(async () => ({ getDocument() {} }), () => '/x/node_modules/pdfjs-dist/package.json');
  assert.ok(pdf.fontDir.includes('standard_fonts'));
  assert.ok(pdf.cmapDir.includes('cmaps'));
});

// ---- invented fixtures ----
test('makePdf writes exact cross-reference offsets', () => {
  const pdf = makePdf([{ lines: ['One (a)', 'Two'] }, { image: true }]).toString('latin1');
  assert.ok(pdf.startsWith('%PDF-1.4'));
  const xrefAt = Number(pdf.match(/startxref\n(\d+)/)[1]);
  assert.ok(pdf.slice(xrefAt).startsWith('xref'));
  const offsets = [...pdf.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  offsets.forEach((at, i) => assert.ok(pdf.slice(at).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
  assert.ok(pdf.includes('(One \\(a\\)) Tj'));
});

test('makeDocx writes a zip with correct checksums and the three Word parts', () => {
  const zip = makeDocx(['Invented paragraph']);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const names = [];
  let at = 0;
  while (zip.readUInt32LE(at) === 0x04034b50) {
    const crc = zip.readUInt32LE(at + 14);
    const size = zip.readUInt32LE(at + 18);
    const nameLength = zip.readUInt16LE(at + 26);
    const name = zip.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const data = zip.subarray(at + 30 + nameLength, at + 30 + nameLength + size);
    assert.equal(crc32(data), crc, name);
    names.push(name);
    at += 30 + nameLength + size;
  }
  assert.deepEqual(names, ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
  assert.ok(zip.toString('utf8').includes('Invented paragraph'));
});

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

// ---- spike script ----
test('spike parseArgs', () => {
  assert.deepEqual(parseArgs([]).only, CHECKS);
  assert.deepEqual(parseArgs(['--only', 'pdf,scan']).only, ['pdf', 'scan']);
  assert.equal(parseArgs(['--file', 'a.pdf']).file, 'a.pdf');
  assert.throws(() => parseArgs(['--only', 'nope']));
  assert.throws(() => parseArgs(['--file']));
  assert.throws(() => parseArgs(['--what']));
});

test('spike typeForFile', () => {
  assert.equal(typeForFile('x/Brief.PDF'), PDF_TYPE);
  assert.equal(typeForFile('a.docx'), DOCX_TYPE);
  assert.equal(typeForFile('a.doc'), null);
});

test('spike judge', () => {
  assert.equal(judge('broken', { ok: false, reason: 'unreadable' }).verdict, 'PASS');
  assert.equal(judge('broken', { ok: true }).verdict, 'FAIL');
  assert.equal(judge('scan', { ok: true, scanned: true, text: '' }).verdict, 'PASS');
  assert.equal(judge('pdf', { ok: true, pageCount: 2, scanned: false, text: `${MARKERS.pdfOne}\n${MARKERS.pdfTwo}` }).verdict, 'PASS');
  assert.equal(judge('long', { ok: true, pageCount: LONG_PAGES, pagesRead: MAX_PAGES, truncated: true }).verdict, 'PASS');
  assert.equal(judge('docx', { ok: false, reason: 'not-installed' }).verdict, 'FAIL');
});

test('spike --file report never contains the document text', async () => {
  const secret = 'Invented sentence that must not be printed';
  const extract = async () => ({ ok: true, kind: 'pdf', text: secret, pageCount: 1, pagesRead: 1, pageChars: [40], scanned: false, lowTextPages: [], truncated: false, warnings: 0, ms: 5 });
  const report = await runSpike({ only: [], file: 'brief.pdf', extract, read: async () => Buffer.from('x') });
  const text = formatReport(report, {}).join('\n');
  assert.ok(!text.includes(secret));
  assert.equal(report.fileResult.chars, secret.length);
  assert.equal(summary({ ok: false, kind: 'pdf', reason: 'timeout', ms: 1 }).reason, 'timeout');
  const wrong = await runSpike({ only: [], file: 'notes.txt', extract });
  assert.match(wrong.fileResult.error, /only \.pdf and \.docx/);
});

// ---- real libraries, when installed (Claude Code and the Codespace after npm install) ----
async function librariesInstalled() {
  const m = await loadMammoth();
  const p = await loadPdfjs();
  return !m.error && !p.error;
}

test('real libraries read the invented fixtures (skipped if not installed)', async (t) => {
  if (!(await librariesInstalled())) {
    t.skip('mammoth or pdfjs-dist not installed');
    return;
  }
  const report = await runSpike();
  for (const r of report.results) assert.equal(r.verdict, 'PASS', `${r.check}: ${r.reasons.join('; ')}`);
});
