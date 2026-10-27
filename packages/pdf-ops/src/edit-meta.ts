/**
 * Edit metadata (docs/m3-contract.md 5.6, D1 amendment 4): records Info /PdfEditorEdits, updates /ModDate, checks the PDF/A declaration.
 * core calls it inside the commit operation on every commit (once at the end for reapply). The record stays in the journal, so it moves with undo/redo.
 * /Producer and XMP ModifyDate are not changed (a mismatch is only recorded, docs/m3-pdf-ops.md).
 */
import type * as mupdf from 'mupdf';
import { latin1String } from './edit-common.js';
import { readStreamBytes } from './mupdf-util.js';

const KEY = 'PdfEditorEdits';

/** Parses "pages=1,3; structure=not-updated". */
export function parseEditsInfo(s: string): { pages: number[]; structure: string | null } {
  const pages = /pages=([\d,\s]*)/.exec(s)?.[1] ?? '';
  const structure = /structure=([a-z/-]+)/.exec(s)?.[1] ?? null;
  return {
    pages: pages
      .split(',')
      .map((p) => Number(p.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
    structure,
  };
}

/** PDF date string (UTC). */
export function pdfDate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `D:${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/**
 * Info dictionary. core creates it before turning on the journal (outside the operation) (contract D9 amendment 1). Creating the trailer /Info inside the operation
 * would not be recorded in the journal and would leave a dangling reference after the operation is discarded, so it is not created here.
 */
function infoDict(doc: mupdf.PDFDocument): mupdf.PDFObject {
  const info = doc.getTrailer().get('Info');
  if (!info.isDictionary()) {
    throw new Error('Info 사전 없음: core 가 저널을 켜기 전에 만들어야 한다(계약 D9 수정 1)');
  }
  return info;
}

/** Previous-session record per document (the value just before this session's first record). Read only once so it is not mixed with this session's records. */
const baselines = new WeakMap<mupdf.PDFDocument, { pages: number[]; structure: string | null }>();

/**
 * pages is the page index (from 0) of all active edits and is written 1-based in Info. It is written as a union with the previous session's page numbers,
 * so the same input gives the same /PdfEditorEdits (idempotent). /ModDate is the call time. core creates the Info dictionary beforehand.
 */
export function recordMetadata(
  doc: mupdf.PDFDocument,
  info: { pages: number[]; structureNotUpdated: boolean },
  date: Date = new Date(),
): void {
  // After adding objects the trailer must be fetched again to get the current value (contract 5.6 amendment 4, S3 measurement): infoDict fetches it each time.
  const dict = infoDict(doc);
  let base = baselines.get(doc);
  if (!base) {
    const prev = dict.get(KEY);
    base = prev.isString() ? parseEditsInfo(prev.asString()) : { pages: [], structure: null };
    baselines.set(doc, base);
  }
  const pages = [...new Set([...base.pages, ...info.pages.map((p) => p + 1)])].sort(
    (a, b) => a - b,
  );
  const structure =
    info.structureNotUpdated || base.structure === 'not-updated' ? 'not-updated' : 'n/a';
  dict.put(KEY, doc.newString(`pages=${pages.join(',')}; structure=${structure}`));
  dict.put('ModDate', doc.newString(pdfDate(date)));
}

/** Whether the document /Metadata (XMP) has a PDF/A declaration (pdfaid:part). */
export function pdfaDeclared(doc: mupdf.PDFDocument): boolean {
  const meta = doc.getTrailer().get('Root').get('Metadata');
  if (!meta.isStream()) return false;
  try {
    const xmp = latin1String(readStreamBytes(meta));
    return /pdfaid:part\s*(=|>)/.test(xmp);
  } catch {
    return false;
  }
}
