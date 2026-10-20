/**
 * 편집 어댑터: core 편집 세션이 부르는 pdf-ops·reflow 편집 함수의 내부 경계(docs/m3-core.md 3절).
 * 기본 구현은 계약 커밋에 고정된 시그니처를 그대로 부른다. S1(pdf-ops)·S2(reflow) 가 병합되기 전에는 그 함수들이
 * "M3 미구현" 예외를 내므로, core 단위 테스트는 가짜 어댑터를 `PdfSessionOptions.editAdapter` 로 넣어 돌린다.
 */
import * as mupdf from 'mupdf';
import {
  FontManager,
  type FallbackFontSource,
  listEditBlocks,
  planPageEditability,
  planParagraphEdit,
  planPathEdit,
  planPathEditability,
  prepareParagraphEdit,
  preparePathEdit,
  recordEditMetadata,
  writeEditBlock,
  writePathEdit,
} from '@pdf-editor/pdf-ops';
import { layoutParagraph } from '@pdf-editor/reflow';
import type { EditWarning, Rect } from '@pdf-editor/shared-types';

export type {
  EditBlockRef,
  ParagraphEditContext,
  PreparedEdit,
  PreparedPathEdit,
  WriteResult,
} from '@pdf-editor/pdf-ops';

/**
 * 패스 쓰기 결과. pdf-ops 시그니처(`{ bbox, writeMs }`)에 쓰는 도중 정해지는 경고(`color-space-changed`·`path-clipped`,
 * 계약 4.2)를 실을 선택 필드를 더했다. pdf-ops 가 채우면 core 가 초안 경고에 합친다(docs/m4-core.md 6절).
 */
export type PathWriteResult = ReturnType<typeof writePathEdit> & { warnings?: EditWarning[] };

export interface EditAdapter {
  /** 문서당 하나. `fallback` 은 core 가 미리 await 한 폴백 폰트 바이트와, 저널을 켜기 직전에 임베딩한 객체(그 전에는 null)다. */
  createFonts(doc: mupdf.PDFDocument, fallback: FallbackFontSource): FontManager;
  planPageEditability: typeof planPageEditability;
  planParagraphEdit: typeof planParagraphEdit;
  prepareParagraphEdit: typeof prepareParagraphEdit;
  /** M4 패스 판정·계획·준비·쓰기(docs/m4-contract.md 4.2–4.3). */
  planPathEditability: typeof planPathEditability;
  planPathEdit: typeof planPathEdit;
  preparePathEdit: typeof preparePathEdit;
  writePathEdit: (...args: Parameters<typeof writePathEdit>) => PathWriteResult;
  writeEditBlock: typeof writeEditBlock;
  listEditBlocks: typeof listEditBlocks;
  recordEditMetadata: typeof recordEditMetadata;
  layoutParagraph: typeof layoutParagraph;
  /**
   * 세션 로그에 없는 편집 블록(다른 세션이 만든 파일)의 영역을 어림한다(페이지 공간). 모르면 null.
   * 기본 구현은 블록 Form 의 /BBox(계약 D3: 사용자 공간으로 옮긴 areaLimit)를 쪽 변환으로 옮긴다.
   */
  blockBounds(doc: mupdf.PDFDocument, pageIndex: number, objectNumber: number): Rect | null;
}

/** 블록 Form 의 /BBox 를 쪽 변환(사용자 공간 → 페이지 공간)으로 옮긴다. */
function formBoundsInPage(
  doc: mupdf.PDFDocument,
  pageIndex: number,
  objectNumber: number,
): Rect | null {
  const form = doc.newIndirect(objectNumber).resolve();
  const bbox = form.get('BBox');
  if (!bbox.isArray() || bbox.length < 4) return null;
  const values = [0, 1, 2, 3].map((i) => bbox.get(i).asNumber());
  if (values.some((v) => !Number.isFinite(v))) return null;
  const page = doc.loadPage(pageIndex);
  try {
    const [x0, y0, x1, y1] = mupdf.Rect.transform(
      [
        Math.min(values[0]!, values[2]!),
        Math.min(values[1]!, values[3]!),
        Math.max(values[0]!, values[2]!),
        Math.max(values[1]!, values[3]!),
      ],
      page.getTransform(),
    );
    return [x0, y0, x1, y1];
  } finally {
    page.destroy();
  }
}

export const defaultEditAdapter: EditAdapter = {
  createFonts: (doc, fallback) => new FontManager(doc, fallback),
  planPageEditability,
  planParagraphEdit,
  prepareParagraphEdit,
  planPathEditability,
  planPathEdit,
  preparePathEdit,
  writePathEdit,
  writeEditBlock,
  listEditBlocks,
  recordEditMetadata,
  layoutParagraph,
  blockBounds: formBoundsInPage,
};
