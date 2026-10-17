import * as mupdf from 'mupdf';
import type { Rect } from '@pdf-editor/shared-types';

/**
 * M0 스파이크 샘플 PDF(A4 1쪽).
 * 교체 대상 문단이 옅은 배경 패널 위에 있고, 표 괘선(가로·세로)이 문단을 가로지르며,
 * 문단 오른쪽 redaction 영역 안에 이미지가 있다. 원본 글꼴은 Helvetica(라틴)뿐이라
 * 교체 문단의 한글은 폴백 폰트 임베딩이 필요하다.
 */

export const PAGE_WIDTH = 595;
export const PAGE_HEIGHT = 842;

export const TITLE_TEXT = 'M0 Spike Sample: Paragraph Replacement';
export const TARGET_LINES = [
  'This paragraph is the replacement target. It sits on a tinted panel',
  'with table rules crossing it. Redaction must remove only this text',
  'and keep the background, the rules, the border and the image.',
  'Line four ends the target paragraph.',
];
export const ADJACENT_LINES = [
  'Adjacent paragraph: must stay unchanged after the edit.',
  'Second line of the adjacent paragraph.',
];
export const FOOTER_TEXT = 'Footer text outside the panel.';

/**
 * redaction 영역(MuPDF 페이지 좌표, 원점 좌상단). PDF 좌표 [56, 650, 540, 714].
 * 이미지 보존을 확인하려고 문단 오른쪽 이미지까지 덮는다.
 */
export const TARGET_RECT: Rect = [56, PAGE_HEIGHT - 714, 540, PAGE_HEIGHT - 650];

/** 새 문단 배치 영역 = 원 문단 영역(이미지 왼쪽). PDF 좌표 [56, 650, 470, 714]. */
export const TARGET_TEXT_BOX: Rect = [56, PAGE_HEIGHT - 714, 470, PAGE_HEIGHT - 650];

function escapePdfString(s: string): string {
  return s.replace(/[\\()]/g, (c) => `\\${c}`);
}

function textLines(
  font: string,
  size: number,
  x: number,
  y0: number,
  lead: number,
  lines: string[],
): string {
  return lines
    .map(
      (line, i) =>
        `BT /${font} ${size} Tf 0 0 0 rg ${x} ${y0 - i * lead} Td (${escapePdfString(line)}) Tj ET`,
    )
    .join('\n');
}

/** 결정적 그라디언트 이미지(64x64 RGB). */
function gradientImage(seed = 0): mupdf.Image {
  const size = 64;
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, size, size], false);
  const px = pix.getPixels();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      px[i] = (x * 4 + seed) & 0xff;
      px[i + 1] = (y * 4) & 0xff;
      px[i + 2] = 160;
    }
  }
  return new mupdf.Image(pix);
}

export interface SampleOptions {
  /** false 면 교체 대상 문단을 뺀 "기대 결과" 페이지를 만든다. */
  includeTarget?: boolean;
}

function samplePageContent(includeTarget: boolean): string {
  return [
    // 배경 패널과 테두리
    '0.93 0.95 1 rg 50 560 495 160 re f',
    '0.2 0.3 0.6 RG 1 w 50 560 495 160 re S',
    // 표 괘선: 가로 y=600/640/680, 세로 x=300 (y=680, x=300 은 대상 문단을 지난다)
    '0.4 0.4 0.4 RG 0.75 w 50 600 m 545 600 l S 50 640 m 545 640 l S 50 680 m 545 680 l S',
    '300 560 m 300 720 l S',
    // 이미지: redaction 영역 안(오른쪽)
    'q 56 0 0 56 478 654 cm /Im1 Do Q',
    textLines('F2', 18, 56, 780, 0, [TITLE_TEXT]),
    includeTarget ? textLines('F1', 11, 60, 700, 14, TARGET_LINES) : '',
    textLines('F1', 11, 60, 620, 14, ADJACENT_LINES),
    textLines('F1', 10, 56, 530, 0, [FOOTER_TEXT]),
  ]
    .filter(Boolean)
    .join('\n');
}

export function addSamplePage(doc: mupdf.PDFDocument, options: SampleOptions = {}): void {
  const resources = {
    Font: {
      F1: doc.addSimpleFont(new mupdf.Font('Helvetica')),
      F2: doc.addSimpleFont(new mupdf.Font('Helvetica-Bold')),
    },
    XObject: { Im1: doc.addImage(gradientImage()) },
  };
  const content = samplePageContent(options.includeTarget ?? true);
  doc.insertPage(-1, doc.addPage([0, 0, PAGE_WIDTH, PAGE_HEIGHT], 0, resources, content));
}

export function buildSamplePdf(options: SampleOptions = {}): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    addSamplePage(doc, options);
    return doc.saveToBuffer('compress').asUint8Array().slice();
  } finally {
    doc.destroy();
  }
}

/**
 * 합성 벤치마크 문서: 샘플 페이지 N장, 페이지마다 고유 잡음 이미지(512x512 RGB, 압축 불가)를
 * 붙여 파일 크기를 키운다. 실제 코퍼스 벤치마크 전 상한 추정용.
 */
export function buildSyntheticPdf(pages: number, noiseSize = 512): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    let state = 0x12345678;
    const rand = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state & 0xff;
    };
    const fonts = {
      F1: doc.addSimpleFont(new mupdf.Font('Helvetica')),
      F2: doc.addSimpleFont(new mupdf.Font('Helvetica-Bold')),
    };
    for (let p = 0; p < pages; p++) {
      const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, noiseSize, noiseSize], false);
      const px = pix.getPixels();
      for (let i = 0; i < px.length; i++) px[i] = rand();
      const noise = doc.addImage(new mupdf.Image(pix));
      pix.destroy();
      const resources = {
        Font: fonts,
        XObject: { Im1: doc.addImage(gradientImage(p)), Im2: noise },
      };
      const content = `${samplePageContent(true)}\nq 200 0 0 200 56 300 cm /Im2 Do Q`;
      doc.insertPage(-1, doc.addPage([0, 0, PAGE_WIDTH, PAGE_HEIGHT], 0, resources, content));
    }
    return doc.saveToBuffer('compress').asUint8Array().slice();
  } finally {
    doc.destroy();
  }
}
