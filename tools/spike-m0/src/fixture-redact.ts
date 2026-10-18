import * as mupdf from 'mupdf';
import type { Rect } from '@pdf-editor/shared-types';
import { addSamplePage, PAGE_HEIGHT } from './fixture.js';

/**
 * 기존 Redact 주석이 있는 문서(A4 2쪽, 두 쪽 모두 Day 1 샘플 페이지).
 * 1쪽: 인접 문단을 덮는 Redact(R1, OverlayText), 교체 대상 문단 첫 줄 일부와 겹치는 Redact(R2),
 *      교체 대상 영역 안의 메모(Text) 주석, 교체 대상 첫 줄 위의 링크.
 * 2쪽: 꼬리말을 덮는 Redact(R3).
 * 좌표는 MuPDF 페이지 좌표(원점 좌상단).
 */
export const R1_ADJACENT: Rect = [56, PAGE_HEIGHT - 636, 400, PAGE_HEIGHT - 604];
export const R2_OVERLAP: Rect = [56, PAGE_HEIGHT - 712, 300, PAGE_HEIGHT - 694];
export const R3_FOOTER: Rect = [50, PAGE_HEIGHT - 540, 300, PAGE_HEIGHT - 520];
export const NOTE_RECT: Rect = [440, PAGE_HEIGHT - 690, 460, PAGE_HEIGHT - 670];
export const LINK_RECT: Rect = [60, PAGE_HEIGHT - 702, 200, PAGE_HEIGHT - 692];
export const LINK_URI = 'https://example.com/m0-link';
export const R1_OVERLAY = 'REDACTED (R1)';

export function buildPreexistingRedactPdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    addSamplePage(doc);
    addSamplePage(doc);
    const p1 = doc.loadPage(0);
    const r1 = p1.createAnnotation('Redact');
    r1.setRect(R1_ADJACENT);
    r1.setContents('R1: 인접 문단 가림 표시(적용 대기)');
    r1.getObject().put('OverlayText', doc.newString(R1_OVERLAY));
    r1.update();
    const r2 = p1.createAnnotation('Redact');
    r2.setRect(R2_OVERLAP);
    r2.setContents('R2: 교체 대상 첫 줄 일부와 겹침');
    r2.update();
    const note = p1.createAnnotation('Text');
    note.setRect(NOTE_RECT);
    note.setContents('교체 대상 영역 안의 메모');
    note.update();
    p1.createLink(LINK_RECT, LINK_URI);
    const p2 = doc.loadPage(1);
    const r3 = p2.createAnnotation('Redact');
    r3.setRect(R3_FOOTER);
    r3.setContents('R3: 2쪽 꼬리말 가림 표시');
    r3.update();
    return doc.saveToBuffer('compress').asUint8Array().slice();
  } finally {
    doc.destroy();
  }
}
