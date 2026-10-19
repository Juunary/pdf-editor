/**
 * 편집 메타(docs/m3-contract.md 5.6·D1 수정 4): Info /PdfEditorEdits 기록, /ModDate 갱신, PDF/A 선언 확인.
 * core 가 커밋 작업 안에서 커밋마다(재적용은 끝에서 한 번) 부른다. 기록이 저널에 남아 undo·redo 와 함께 움직인다.
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

/**
 * Info 사전. core 가 저널을 켜기 전(작업 밖)에 만들어 둔다(계약 D9 수정 1). 작업 안에서 trailer /Info 를 만들면
 * 저널에 기록되지 않아 작업을 버린 뒤 끊긴 참조가 되므로 여기서는 만들지 않는다.
 */
function infoDict(doc: mupdf.PDFDocument): mupdf.PDFObject {
  const info = doc.getTrailer().get('Info');
  if (!info.isDictionary()) {
    throw new Error('Info 사전 없음: core 가 저널을 켜기 전에 만들어야 한다(계약 D9 수정 1)');
  }
  return info;
}

/** 문서별 이전 세션 기록(이 세션의 첫 기록 직전 값). 이 세션 기록과 섞지 않으려고 한 번만 읽는다. */
const baselines = new WeakMap<mupdf.PDFDocument, { pages: number[]; structure: string | null }>();

/**
 * pages 는 활성 편집 전체의 쪽 인덱스(0부터)이고 Info 에는 1부터 적는다. 이전 세션의 쪽 번호와 합집합으로 쓰며,
 * 같은 입력이면 같은 /PdfEditorEdits 가 된다(멱등). /ModDate 는 호출 시각. Info 사전은 core 가 만들어 둔다.
 */
export function recordMetadata(
  doc: mupdf.PDFDocument,
  info: { pages: number[]; structureNotUpdated: boolean },
  date: Date = new Date(),
): void {
  // 객체를 더한 뒤에는 trailer 를 다시 받아야 현재 값이 나온다(계약 5.6 수정 4, S3 실측): infoDict 가 매번 받는다.
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
