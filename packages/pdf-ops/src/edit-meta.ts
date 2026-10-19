/**
 * 저장 메타(docs/m3-contract.md 5.6·D1): Info /PdfEditorEdits 기록, /ModDate 갱신, PDF/A 선언 확인.
 * /Producer 와 XMP ModifyDate 는 바꾸지 않는다(불일치는 기록만, docs/m3-pdf-ops.md).
 */
import type * as mupdf from 'mupdf';
import { latin1String } from './edit-common.js';
import { readStreamBytes } from './mupdf-util.js';

const KEY = 'PdfEditorEdits';

/** "pages=1,3; structure=not-updated" 해석. */
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

/** PDF 날짜 문자열(UTC). */
export function pdfDate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `D:${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** Info 사전(없으면 만든다. 저장 작업 안에서 만들면 버린 뒤 끊긴 참조가 되므로 첫 편집 작업에서 만들어 둔다). */
function infoDict(doc: mupdf.PDFDocument): mupdf.PDFObject {
  const trailer = doc.getTrailer();
  const info = trailer.get('Info');
  if (info.isDictionary()) return info;
  const ref = doc.addObject(doc.newDictionary());
  trailer.put('Info', ref);
  return ref;
}

/** pages 는 0부터. Info 에는 1부터 적고 기존 값과 합집합으로 합친다. */
export function recordMetadata(
  doc: mupdf.PDFDocument,
  info: { pages: number[]; structureNotUpdated: boolean },
  date: Date = new Date(),
): void {
  const dict = infoDict(doc);
  const prev = dict.get(KEY);
  const old = prev.isString() ? parseEditsInfo(prev.asString()) : { pages: [], structure: null };
  const pages = [...new Set([...old.pages, ...info.pages.map((p) => p + 1)])].sort((a, b) => a - b);
  const structure =
    info.structureNotUpdated || old.structure === 'not-updated' ? 'not-updated' : 'n/a';
  dict.put(KEY, doc.newString(`pages=${pages.join(',')}; structure=${structure}`));
  dict.put('ModDate', doc.newString(pdfDate(date)));
}

/** 문서 /Metadata(XMP)에 PDF/A 선언(pdfaid:part)이 있는가. */
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
