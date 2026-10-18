// 합성 PDF 생성 도구(테스트 전용). 폰트 F1 = Helvetica(단순 폰트), F2 = NotoSansKR 부분집합(CID, 한글).
import '../src/wasm-module.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as mupdf from 'mupdf';

const KOREAN_FONT_PATH = fileURLToPath(
  new URL('../../../assets/fonts/NotoSansKR-Regular-subset.ttf', import.meta.url),
);

export const koreanFont = new mupdf.Font('NotoSansKR', readFileSync(KOREAN_FONT_PATH));

/** F2(CID) 로 보여 줄 문자열을 `<gid…> Tj` 에 쓰는 16진 문자열로 만든다. */
export function hexGlyphs(text: string, font = koreanFont): string {
  return `<${[...text].map((c) => font.encodeCharacter(c).toString(16).padStart(4, '0')).join('')}>`;
}

export interface PageSpec {
  content: string;
  mediabox?: [number, number, number, number];
  rotate?: 0 | 90 | 180 | 270;
  /** 리소스 사전에 항목을 더한다(ExtGState·ColorSpace·XObject 등). */
  resources?: (doc: mupdf.PDFDocument, resources: Record<string, unknown>) => void;
}

export function buildDocument(pages: Array<string | PageSpec>): mupdf.PDFDocument {
  const doc = new mupdf.PDFDocument();
  const f1 = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  const f2 = doc.addFont(koreanFont);
  for (const page of pages) {
    const spec: PageSpec = typeof page === 'string' ? { content: page } : page;
    const resources: Record<string, unknown> = { Font: { F1: f1, F2: f2 } };
    spec.resources?.(doc, resources);
    doc.insertPage(
      -1,
      doc.addPage(spec.mediabox ?? [0, 0, 300, 200], spec.rotate ?? 0, resources, spec.content),
    );
  }
  return doc;
}

export function buildPdf(pages: Array<string | PageSpec>): Uint8Array {
  const doc = buildDocument(pages);
  const buffer = doc.saveToBuffer('');
  const bytes = buffer.asUint8Array().slice();
  buffer.destroy();
  doc.destroy();
  return bytes;
}
