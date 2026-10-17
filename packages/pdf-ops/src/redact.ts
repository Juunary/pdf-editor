import * as mupdf from 'mupdf';
import type { Rect } from '@pdf-editor/shared-types';

/** `applyRedaction(black_boxes, image_method, line_art_method, text_method)` 인자. */
export interface RedactionOptions {
  blackBoxes: boolean;
  imageMethod: number;
  lineArtMethod: number;
  textMethod: number;
}

/**
 * 텍스트 교체용 redaction 옵션(PLAN.md 3.1): 텍스트 제거, 선화·이미지 보존, 검은 상자 없음.
 * MuPDF 기본값(black_boxes=true, 이미지 픽셀 제거, 덮인 선화 제거)은 교체 용도에 맞지 않는다.
 */
export const TEXT_REPLACE_REDACTION: Readonly<RedactionOptions> = Object.freeze({
  blackBoxes: false,
  imageMethod: mupdf.PDFPage.REDACT_IMAGE_NONE,
  lineArtMethod: mupdf.PDFPage.REDACT_LINE_ART_NONE,
  textMethod: mupdf.PDFPage.REDACT_TEXT_REMOVE,
});

export interface RedactionResult {
  appliedRects: Rect[];
  /** 적용 전부터 페이지에 있던 Redact 주석 수. 이 함수는 그 주석을 적용하지 않는다. */
  preexistingRedactAnnots: number;
}

export function countRedactAnnots(page: mupdf.PDFPage): number {
  return page.getAnnotations().filter((a) => a.getType() === 'Redact').length;
}

/**
 * 영역 안의 텍스트를 제거한다. `rects` 는 MuPDF 페이지 좌표(원점 좌상단).
 *
 * 페이지 단위 `applyRedactions()` 는 문서에 원래 있던 Redact 주석까지 적용하므로,
 * 새로 만든 주석만 주석 단위 `applyRedaction()` 으로 적용한다.
 */
export function redactRegions(
  page: mupdf.PDFPage,
  rects: readonly Rect[],
  options: Readonly<RedactionOptions> = TEXT_REPLACE_REDACTION,
): RedactionResult {
  const preexistingRedactAnnots = countRedactAnnots(page);
  for (const rect of rects) {
    const annot = page.createAnnotation('Redact');
    annot.setRect(rect);
    annot.applyRedaction(
      Number(options.blackBoxes),
      options.imageMethod,
      options.lineArtMethod,
      options.textMethod,
    );
  }
  return { appliedRects: rects.map((r) => [...r] as Rect), preexistingRedactAnnots };
}
