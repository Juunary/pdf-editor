/** 편집 엔진 시험 공용 도구: 가짜 어댑터를 넣은 세션, 문단 편집 흐름, 문서 상태 읽기. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type * as mupdf from 'mupdf';
import { PdfSession } from '../src/index.js';
import type { DraftInput, ParagraphEditPlan, TextRun } from '@pdf-editor/shared-types';
import { createFakeAdapter, type FakeAdapter } from './fake-edit-adapter.js';
import { buildPdf } from './pdf-fixtures.js';

export const FONT_BYTES = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL('../../../assets/fonts/NotoSansKR-Regular-subset.ttf', import.meta.url)),
  ),
);

export const PAGE = [
  'BT /F1 18 Tf 72 720 Td (Title Heading) Tj ET',
  'BT /F1 10 Tf 72 690 Td (first paragraph line one is long enough to fill the column) Tj',
  '0 -12 Td (and it continues on this line.) Tj ET',
  'BT /F1 10 Tf 72 640 Td (Second paragraph starts here and ends.) Tj ET',
].join('\n');
export const MEDIABOX: [number, number, number, number] = [0, 0, 612, 792];

export const FIRST_PARAGRAPH =
  'first paragraph line one is long enough to fill the column and it continues on this line.';

export interface Harness {
  s: PdfSession;
  adapter: FakeAdapter;
  fontLoads: { count: number };
}

export function harness(pageCount = 1, options: { noInfo?: boolean } = {}): Harness {
  const adapter = createFakeAdapter();
  const fontLoads = { count: 0 };
  let n = 0;
  const s = new PdfSession({
    editAdapter: adapter,
    loadFallbackFont: async () => {
      fontLoads.count++;
      return FONT_BYTES;
    },
    createId: () => `id-${++n}`,
  });
  const pages = Array.from({ length: pageCount }, () => ({ content: PAGE, mediabox: MEDIABOX }));
  const bytes = buildPdf(pages);
  s.open(bytes);
  if (options.noInfo !== false) {
    // buildPdf 문서에는 /Info 가 없다(첫 편집 RPC 가 만든다).
    expect(s.document.getTrailer().get('Info').isNull()).toBe(true);
  }
  return { s, adapter, fontLoads };
}

export const text = (s: PdfSession, pageIndex = 0): string =>
  s
    .extractPage({ pageIndex })
    .chars.map((c) => c.text)
    .join('');

/** 저널 상태. 저널은 첫 `beginParagraphEdit` 에서 켜지므로 그 전에는 빈 상태다. */
export const journal = (s: PdfSession): { position: number; steps: string[] } => {
  try {
    return s.document.getJournal();
  } catch {
    return { position: 0, steps: [] };
  }
};

export function draftInput(plan: ParagraphEditPlan, newText: string, scale = 2): DraftInput {
  const run: TextRun = { text: newText, style: plan.runs[0]!.style };
  return { runs: [run], format: plan.format, composition: null, renderScale: scale };
}

export async function begin(s: PdfSession, paragraphId: number, pageIndex = 0) {
  const plan = await s.planParagraphEdit(pageIndex, paragraphId);
  const started = await s.beginParagraphEdit(pageIndex, paragraphId, plan.revision);
  return { plan, started };
}

/** 문단 편집 하나(시작 → 갱신 → 커밋). */
export async function editParagraph(
  s: PdfSession,
  paragraphId: number,
  newText: string,
  pageIndex = 0,
) {
  const { plan, started } = await begin(s, paragraphId, pageIndex);
  await s.updateParagraphDraft(started.draftId, draftInput(plan, newText));
  return s.commitParagraphEdit(started.draftId);
}

/** 폴백 폰트 객체 목록(폰트 사전 /PdfEditorFallback 표지). 픽스처의 F2 도 같은 폰트이지만 표지가 없다. */
export function fallbackFonts(doc: mupdf.PDFDocument): mupdf.PDFObject[] {
  const found: mupdf.PDFObject[] = [];
  for (let n = 1; n < doc.countObjects(); n++) {
    const obj = doc.newIndirect(n);
    if (obj.isDictionary() && !obj.get('PdfEditorFallback').isNull()) found.push(obj);
  }
  return found;
}
