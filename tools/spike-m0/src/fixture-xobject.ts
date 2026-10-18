import * as mupdf from 'mupdf';
import type { Rect } from '@pdf-editor/shared-types';
import { PAGE_HEIGHT, PAGE_WIDTH } from './fixture.js';

/**
 * 공유 Form XObject 샘플(A4 2쪽). M0 DoD "공유 XObject" 검증용.
 *
 * - Fx1(카드, BBox 0 0 483 200): 배경·테두리·가로/세로 괘선·제목·문단 3줄(교체 대상)·중첩 Fx2
 * - Fx2(배지, BBox 0 0 150 44): 배경·테두리·2줄(중첩 교체 대상)
 * - 1쪽: Fx1 을 A(y=540)·B(y=300) 두 곳에서 그림
 * - 2쪽: Fx1 을 C(y=540)·D(0.8배, y=300) 두 곳 + Fx2 직접 1곳(E)
 * - 두 페이지는 Resources 간접 객체 1개를 공유한다
 */

export const CARD_BBOX: Rect = [0, 0, 483, 200];
export const BADGE_BBOX: Rect = [0, 0, 150, 44];
/** 1쪽 B 사용 위치 CTM 이동량 */
export const USAGE_B_ORIGIN: [number, number] = [56, 300];

export const CARD_TITLE = 'Shared card title (kept)';
export const CARD_PARAGRAPH = [
  'Shared paragraph line one: replacement target inside Fx1.',
  'Line two crosses a vertical rule drawn by the same form.',
  'Line three ends the shared paragraph.',
];
export const BADGE_LINES = ['Nested badge line one', 'Nested badge line two'];
export const PAGE_TITLE = 'M0 Shared Form XObject Sample';
export const PAGE_FOOTERS = ['Page 1 footer (page content).', 'Page 2 footer (page content).'];

/** 교체 대상 문단 영역(Fx1 공간, PDF 좌표) */
export const CARD_PARAGRAPH_RECT: Rect = [6, 90, 477, 140];
/** 새 문단 배치 영역(Fx1 공간) */
export const CARD_TEXT_BOX: Rect = [12, 90, 470, 140];
/** 중첩 교체 대상 영역(Fx2 공간) */
export const BADGE_TEXT_RECT: Rect = [2, 10, 148, 40];
/** 중첩 새 텍스트 배치 영역(Fx2 공간) */
export const BADGE_TEXT_BOX: Rect = [6, 8, 146, 40];

export type SharedXObjectVariant =
  /** 원본 */
  | 'original'
  /** 기대 결과: 1쪽 B 의 Fx1 에서 문단만 없음 */
  | 'expected-b-card'
  /** 기대 결과: 1쪽 B 안의 Fx2 에서 텍스트만 없음 */
  | 'expected-b-badge'
  /** 기대 결과: 위 두 가지 모두 */
  | 'expected-b-both';

function esc(s: string): string {
  return s.replace(/[\\()]/g, (c) => `\\${c}`);
}

function badgeContent(withText: boolean): string {
  return [
    '1 0.92 0.8 rg 0 0 150 44 re f',
    '0.6 0.4 0.1 RG 0.5 w 0.25 0.25 149.5 43.5 re S',
    withText
      ? `BT /F1 9 Tf 0 0 0 rg 6 28 Td (${esc(BADGE_LINES[0]!)}) Tj 0 -12 Td (${esc(BADGE_LINES[1]!)}) Tj ET`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function cardContent(withParagraph: boolean): string {
  return [
    '0.93 0.95 1 rg 0 0 483 200 re f',
    '0.2 0.3 0.6 RG 1 w 0.5 0.5 482 199 re S',
    '0.4 0.4 0.4 RG 0.75 w 0 150 m 483 150 l S 300 60 m 300 150 l S',
    `BT /F2 14 Tf 0 0 0 rg 12 172 Td (${esc(CARD_TITLE)}) Tj ET`,
    withParagraph
      ? `BT /F1 11 Tf 0 0 0 rg 12 126 Td (${esc(CARD_PARAGRAPH[0]!)}) Tj 0 -14 Td (${esc(CARD_PARAGRAPH[1]!)}) Tj 0 -14 Td (${esc(CARD_PARAGRAPH[2]!)}) Tj ET`
      : '',
    'q 1 0 0 1 320 8 cm /Fx2 Do Q',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildSharedXObjectPdf(variant: SharedXObjectVariant = 'original'): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const F1 = doc.addSimpleFont(new mupdf.Font('Helvetica'));
    const F2 = doc.addSimpleFont(new mupdf.Font('Helvetica-Bold'));
    const form = (content: string, bbox: Rect, resources: Record<string, unknown>) =>
      doc.addStream(content, {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: bbox,
        Resources: resources,
      });
    const badge = form(badgeContent(true), BADGE_BBOX, { Font: { F1 } });
    const card = form(cardContent(true), CARD_BBOX, { Font: { F1, F2 }, XObject: { Fx2: badge } });
    const shared = doc.addObject({ Font: { F1, F2 }, XObject: { Fx1: card, Fx2: badge } });

    // 기대 결과 변형: 1쪽 B 만 다른 Form 을 그린다(페이지 콘텐츠의 B 리소스 이름만 바꾼다).
    let pageOneResources: mupdf.PDFObject | Record<string, unknown> = shared;
    let usageB = 'Fx1';
    if (variant !== 'original') {
      const cardPara = variant === 'expected-b-badge';
      const badgeText = variant === 'expected-b-card';
      const b2 = form(badgeContent(badgeText), BADGE_BBOX, { Font: { F1 } });
      const b1 = form(cardContent(cardPara), CARD_BBOX, { Font: { F1, F2 }, XObject: { Fx2: b2 } });
      pageOneResources = { Font: { F1, F2 }, XObject: { Fx1: card, Fx2: badge, Fx1x: b1 } };
      usageB = 'Fx1x';
    }
    const [bx, by] = USAGE_B_ORIGIN;
    doc.insertPage(
      -1,
      doc.addPage(
        [0, 0, PAGE_WIDTH, PAGE_HEIGHT],
        0,
        pageOneResources,
        [
          `BT /F2 18 Tf 0 0 0 rg 56 790 Td (${esc(PAGE_TITLE)}) Tj ET`,
          'q 1 0 0 1 56 540 cm /Fx1 Do Q',
          `q 1 0 0 1 ${bx} ${by} cm /${usageB} Do Q`,
          `BT /F1 10 Tf 0 0 0 rg 56 100 Td (${esc(PAGE_FOOTERS[0]!)}) Tj ET`,
        ].join('\n'),
      ),
    );
    doc.insertPage(
      -1,
      doc.addPage(
        [0, 0, PAGE_WIDTH, PAGE_HEIGHT],
        0,
        shared,
        [
          'q 1 0 0 1 56 540 cm /Fx1 Do Q',
          'q 0.8 0 0 0.8 56 300 cm /Fx1 Do Q',
          'q 1 0 0 1 400 140 cm /Fx2 Do Q',
          `BT /F1 10 Tf 0 0 0 rg 56 100 Td (${esc(PAGE_FOOTERS[1]!)}) Tj ET`,
        ].join('\n'),
      ),
    );
    return doc.saveToBuffer('compress').asUint8Array().slice();
  } finally {
    doc.destroy();
  }
}
