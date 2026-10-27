import * as mupdf from 'mupdf';
import type { Rect } from '@pdf-editor/shared-types';
import { PAGE_HEIGHT, PAGE_WIDTH } from './fixture.js';

/**
 * Shared Form XObject sample (A4, 2 pages). For the M0 DoD "shared XObject" check.
 *
 * - Fx1 (card, BBox 0 0 483 200): background, border, horizontal/vertical rules, title, 3 paragraph lines (replacement target), nested Fx2
 * - Fx2 (badge, BBox 0 0 150 44): background, border, 2 lines (nested replacement target)
 * - Page 1: draws Fx1 in two places, A (y=540) and B (y=300)
 * - Page 2: draws Fx1 in two places, C (y=540) and D (0.8×, y=300), plus Fx2 directly in one place (E)
 * - The two pages share one indirect Resources object
 */

export const CARD_BBOX: Rect = [0, 0, 483, 200];
export const BADGE_BBOX: Rect = [0, 0, 150, 44];
/** CTM translation at page 1 usage location B */
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

/** Replacement target paragraph area (Fx1 space, PDF coordinates) */
export const CARD_PARAGRAPH_RECT: Rect = [6, 90, 477, 140];
/** New paragraph placement area (Fx1 space) */
export const CARD_TEXT_BOX: Rect = [12, 90, 470, 140];
/** Nested replacement target area (Fx2 space) */
export const BADGE_TEXT_RECT: Rect = [2, 10, 148, 40];
/** Nested new text placement area (Fx2 space) */
export const BADGE_TEXT_BOX: Rect = [6, 8, 146, 40];

export type SharedXObjectVariant =
  /** Original */
  | 'original'
  /** Expected result: only the paragraph is gone from Fx1 at page 1 B */
  | 'expected-b-card'
  /** Expected result: only the text is gone from Fx2 inside page 1 B */
  | 'expected-b-badge'
  /** Expected result: both of the above */
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

    // Expected-result variant: only page 1 B draws a different Form (only the B resource name in the page content is changed).
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
