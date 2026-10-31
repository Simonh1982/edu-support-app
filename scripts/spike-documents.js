#!/usr/bin/env node
// Phase 1 spike (WP-102): can the server read text from Word and PDF files, and spot scanned PDFs?
// It builds invented files in memory, so nothing about the learner is used. With --file it also
// reads one document you choose, printing counts only, never the text.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DOCX_TYPE, PDF_TYPE, MAX_PAGES, MAX_DOCUMENT_BYTES, EXTRACT_TIMEOUT_MS, extractDocument,
} from '../server/documents.js';
import { makeDocx, makePdf } from './make-documents.js';

export const CHECKS = Object.freeze(['docx', 'pdf', 'scan', 'broken', 'long']);
export const MARKERS = Object.freeze({
  docx: 'Lighthouse keeper practice task',
  pdfOne: 'Invented river study, page one',
  pdfTwo: 'Second page marker: estuary',
});
export const LONG_PAGES = 60;

export const USAGE = `Usage: npm run spike:docs [-- --only docx,pdf,scan,broken,long] [--file <path to .pdf or .docx>]
--file prints counts only (pages, characters, scan verdict), never the document's text.`;

export function parseArgs(argv) {
  const out = { only: [...CHECKS], file: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--only') {
      const names = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const bad = names.filter((n) => !CHECKS.includes(n));
      if (!names.length || bad.length) throw new Error(`--only takes ${CHECKS.join(', ')}`);
      out.only = names;
    } else if (arg === '--file') {
      const value = argv[++i];
      if (!value) throw new Error('--file needs a path');
      out.file = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return out;
}

/** The document type from a file name, or null. */
export function typeForFile(name) {
  const ext = path.extname(String(name)).toLowerCase();
  if (ext === '.pdf') return PDF_TYPE;
  if (ext === '.docx') return DOCX_TYPE;
  return null;
}

function has(text, phrase) {
  return typeof text === 'string' && text.replace(/\s+/g, ' ').includes(phrase);
}

/** PASS / FAIL for each built-in check, from an extraction result. */
export function judge(check, r) {
  const reasons = [];
  if (check === 'broken') {
    if (r.ok) reasons.push('a damaged file was accepted');
    else if (r.reason !== 'unreadable') reasons.push(`reason was ${r.reason}, expected unreadable`);
  } else if (!r.ok) {
    reasons.push(`not read (${r.reason})`);
  } else if (check === 'docx') {
    if (!has(r.text, MARKERS.docx)) reasons.push('marker text missing');
  } else if (check === 'pdf') {
    if (r.pageCount !== 2) reasons.push(`pageCount ${r.pageCount}, expected 2`);
    if (!has(r.text, MARKERS.pdfOne) || !has(r.text, MARKERS.pdfTwo)) reasons.push('marker text missing');
    if (r.scanned) reasons.push('a text PDF was treated as a scan');
  } else if (check === 'scan') {
    if (!r.scanned) reasons.push('a picture-only PDF was not treated as a scan');
    if (r.text) reasons.push('a scan returned text');
  } else if (check === 'long') {
    if (r.pageCount !== LONG_PAGES) reasons.push(`pageCount ${r.pageCount}, expected ${LONG_PAGES}`);
    if (r.pagesRead !== MAX_PAGES) reasons.push(`read ${r.pagesRead} pages, expected ${MAX_PAGES}`);
    if (!r.truncated) reasons.push('not marked truncated');
  }
  return { verdict: reasons.length ? 'FAIL' : 'PASS', reasons };
}

export function fixtureFor(check) {
  if (check === 'docx') {
    return { mimeType: DOCX_TYPE, bytes: makeDocx([MARKERS.docx, 'Describe two duties & explain why they matter.']) };
  }
  if (check === 'pdf') {
    return {
      mimeType: PDF_TYPE,
      bytes: makePdf([{ lines: [MARKERS.pdfOne, 'Explain two causes of flooding (6 marks).'] }, { lines: [MARKERS.pdfTwo] }]),
    };
  }
  if (check === 'scan') return { mimeType: PDF_TYPE, bytes: makePdf([{ image: true }, { image: true }]) };
  if (check === 'broken') return { mimeType: PDF_TYPE, bytes: Buffer.from('this is not really a PDF file at all') };
  const pages = Array.from({ length: LONG_PAGES }, (_, i) => ({ lines: [`Invented page ${i + 1} of a long handout`, 'Some filler text for length.'] }));
  return { mimeType: PDF_TYPE, bytes: makePdf(pages) };
}

/** Counts only: safe to print for a real document. */
export function summary(r) {
  if (!r.ok) return { ok: false, kind: r.kind, reason: r.reason, ms: r.ms };
  return {
    ok: true, kind: r.kind, pageCount: r.pageCount, pagesRead: r.pagesRead, pageChars: r.pageChars,
    scanned: r.scanned, lowTextPages: r.lowTextPages, chars: r.text.length, truncated: r.truncated,
    warnings: r.warnings, ms: r.ms,
  };
}

export async function runSpike({ only = CHECKS, file = null, extract = extractDocument, read = readFile } = {}) {
  const results = [];
  for (const check of only) {
    const fixture = fixtureFor(check);
    const r = await extract(fixture);
    results.push({ check, ...judge(check, r), result: summary(r) });
  }
  let fileResult = null;
  if (file) {
    const mimeType = typeForFile(file);
    if (!mimeType) fileResult = { error: 'only .pdf and .docx files can be checked' };
    else {
      try {
        const bytes = await read(file);
        fileResult = summary(await extract({ bytes, mimeType }));
      } catch (err) {
        fileResult = { error: `could not open the file (${err?.code ?? err?.name ?? 'error'})` };
      }
    }
  }
  const failed = results.filter((r) => r.verdict !== 'PASS').length;
  return { results, fileResult, verdict: failed ? 'FAIL' : 'PASS' };
}

export function libraryVersions(resolver = createRequire(import.meta.url).resolve, readJson = null) {
  const versions = {};
  for (const name of ['mammoth', 'pdfjs-dist']) {
    try {
      const pkgPath = resolver(`${name}/package.json`);
      const pkg = readJson ? readJson(pkgPath) : createRequire(import.meta.url)(pkgPath);
      versions[name] = pkg.version ?? 'unknown';
    } catch {
      versions[name] = 'not installed';
    }
  }
  return versions;
}

export function formatReport(report, versions = {}) {
  const lines = [];
  lines.push(`Libraries: mammoth ${versions.mammoth ?? '?'}, pdfjs-dist ${versions['pdfjs-dist'] ?? '?'}  Node ${process.versions.node}`);
  lines.push(`Limits: ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB, ${MAX_PAGES} pages, ${EXTRACT_TIMEOUT_MS / 1000} s`);
  for (const r of report.results) {
    lines.push('');
    lines.push(`--- ${r.check}: ${r.verdict} (${r.result.ms} ms)`);
    for (const reason of r.reasons) lines.push(`    problem: ${reason}`);
    const { ms, ...rest } = r.result;
    lines.push(`    ${JSON.stringify(rest)}`);
  }
  if (report.fileResult) {
    lines.push('');
    lines.push('--- your file (counts only, no text):');
    lines.push(`    ${JSON.stringify(report.fileResult)}`);
  }
  lines.push('');
  lines.push(`Overall: ${report.verdict}`);
  return lines;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const report = await runSpike(args);
  for (const line of formatReport(report, libraryVersions())) console.log(line);
  process.exitCode = report.verdict === 'PASS' ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`Spike failed: ${err?.name ?? 'error'}`);
    process.exit(1);
  });
}
