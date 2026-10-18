// M0 DoD 잔여 항목(공유 XObject·기존 Redact 주석·대형 문서 저장) 실행기. cli.ts 에서 호출한다.
import * as mupdf from 'mupdf';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildPreexistingRedactPdf } from './fixture-redact.js';
import { buildSharedXObjectPdf } from './fixture-xobject.js';
import { popplerPng, popplerRaster, popplerText, popplerVersion, ppmDiff } from './poppler.js';
import { REDACT_CASES, runRedactCase } from './redact-spike.js';
import { ADJACENT_LINES } from './fixture.js';
import { REPLACEMENT_TEXT } from './spike.js';
import {
  BADGE_REPLACEMENT,
  CARD_REPLACEMENT,
  runXObjectCase,
  XOBJECT_CASES,
  type XObjectCaseResult,
} from './xobject-spike.js';

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** PDF 사용자 공간 사각형(A4, 회전 없음) → pdftoppm 픽셀 사각형(여유 2px). */
function popplerPixelRect(r: [number, number, number, number], dpi: number, pageHeight = 842) {
  const s = dpi / 72;
  return [
    Math.floor(r[0] * s) - 2,
    Math.floor((pageHeight - r[3]) * s) - 2,
    Math.ceil(r[2] * s) + 2,
    Math.ceil((pageHeight - r[1]) * s) + 2,
  ] as [number, number, number, number];
}
const squash = (s: string) => s.replace(/\s+/g, '');

export interface DodPaths {
  root: string;
  out: string;
  ttf: string;
}

/** 공유 Form XObject 스파이크: 경우별 결과 JSON·저장 PDF·PNG + Poppler 교차 확인. */
export function runXObjectCli({ root, out, ttf }: DodPaths): void {
  mkdirSync(out, { recursive: true });
  const fontBytes = new Uint8Array(readFileSync(ttf));
  const originalPath = join(out, 'xobject-original.pdf');
  const original = buildSharedXObjectPdf('original');
  writeFileSync(originalPath, original);
  const poppler = popplerVersion();
  const originalPpm = poppler
    ? [1, 2].map((p) => popplerRaster(originalPath, p, join(out, `tmp-orig-${p}`)))
    : null;
  const originalText2 = poppler ? popplerText(originalPath, 2) : null;

  const results: Record<string, unknown> = {};
  for (const c of XOBJECT_CASES) {
    const r: XObjectCaseResult = runXObjectCase(c, { fontBytes });
    const { savedBytes, ...rest } = r;
    const pdf = join(out, `xobject-${c}.pdf`);
    writeFileSync(pdf, savedBytes);
    const doc = mupdf.Document.openDocument(savedBytes, 'application/pdf');
    writeFileSync(
      join(out, `xobject-${c}-p1-mupdf.png`),
      doc
        .loadPage(0)
        .toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false)
        .asPNG(),
    );
    doc.destroy();
    let popplerResult: Record<string, unknown> = { available: false };
    if (poppler && originalPpm && originalText2 !== null) {
      popplerPng(pdf, 1, join(out, `xobject-${c}-p1-poppler`));
      const t1 = popplerText(pdf, 1);
      const expectTexts =
        c === 'depth1'
          ? [CARD_REPLACEMENT]
          : c === 'depth2'
            ? [BADGE_REPLACEMENT]
            : c === 'sequential'
              ? [CARD_REPLACEMENT, BADGE_REPLACEMENT]
              : [];
      popplerResult = {
        available: true,
        version: poppler,
        page2DiffPx: ppmDiff(originalPpm[1]!, popplerRaster(pdf, 2, join(out, 'tmp-2'))),
        page1DiffPx: ppmDiff(originalPpm[0]!, popplerRaster(pdf, 1, join(out, 'tmp-1'))),
        page1OutsideSelectedDiffPx: ppmDiff(
          originalPpm[0]!,
          popplerRaster(pdf, 1, join(out, 'tmp-1')),
          popplerPixelRect(r.selectedPageBox, 108),
        ),
        page2TextSame: popplerText(pdf, 2) === originalText2,
        page1NewTextFound: expectTexts.map((t) => squash(t1).includes(squash(t))),
      };
    }
    results[c] = { ...rest, savedSha256: sha256(savedBytes), poppler: popplerResult };
    console.log(`${c}: ${savedBytes.byteLength} B → ${relative(root, pdf)}`);
  }
  const summary = {
    date: new Date().toISOString(),
    fixture: { bytes: original.byteLength, sha256: sha256(original) },
    cases: results,
  };
  writeFileSync(join(out, 'xobject-result.json'), JSON.stringify(summary, null, 2));
  console.log(`결과: ${relative(root, join(out, 'xobject-result.json'))}`);
}

/** 기존 Redact 주석 문서: 경우별 결과 JSON·저장 PDF + Poppler 교차 확인. */
export function runRedactCli({ root, out, ttf }: DodPaths): void {
  mkdirSync(out, { recursive: true });
  const fontBytes = new Uint8Array(readFileSync(ttf));
  const originalPath = join(out, 'redact-original.pdf');
  const original = buildPreexistingRedactPdf();
  writeFileSync(originalPath, original);
  const poppler = popplerVersion();
  const originalPpm2 = poppler ? popplerRaster(originalPath, 2, join(out, 'tmp-orig-2')) : null;
  const results: Record<string, unknown> = {};
  for (const c of REDACT_CASES) {
    const { savedBytes, ...rest } = runRedactCase(c, fontBytes);
    const pdf = join(out, `redact-${c}.pdf`);
    writeFileSync(pdf, savedBytes);
    let popplerResult: Record<string, unknown> = { available: false };
    if (poppler && originalPpm2) {
      const t1 = squash(popplerText(pdf, 1));
      popplerPng(pdf, 1, join(out, `redact-${c}-p1-poppler`));
      popplerResult = {
        available: true,
        version: poppler,
        page2DiffPx: ppmDiff(originalPpm2, popplerRaster(pdf, 2, join(out, 'tmp-2'))),
        adjacentTextFound: ADJACENT_LINES.every((l) => t1.includes(squash(l))),
        newTextFound: t1.includes(squash(REPLACEMENT_TEXT)),
      };
    }
    results[c] = { ...rest, savedSha256: sha256(savedBytes), poppler: popplerResult };
    console.log(`${c}: ${savedBytes.byteLength} B → ${relative(root, pdf)}`);
  }
  const summary = {
    date: new Date().toISOString(),
    fixture: { bytes: original.byteLength, sha256: sha256(original) },
    cases: results,
  };
  writeFileSync(join(out, 'redact-result.json'), JSON.stringify(summary, null, 2));
  console.log(`결과: ${relative(root, join(out, 'redact-result.json'))}`);
}

/** 고정 픽스처(재생성 시 같은 바이트): 공유 XObject·기존 Redact 주석 문서의 원본과 편집 결과. */
export function writeDodFixtures(root: string, ttf: string): { name: string; bytes: Uint8Array }[] {
  const fontBytes = new Uint8Array(readFileSync(ttf));
  return [
    { name: 'm0-shared-xobject.pdf', bytes: buildSharedXObjectPdf('original') },
    {
      name: 'm0-shared-xobject-edited.pdf',
      bytes: runXObjectCase('sequential', { fontBytes }).savedBytes,
    },
    { name: 'm0-preexisting-redact.pdf', bytes: buildPreexistingRedactPdf() },
    {
      name: 'm0-preexisting-redact-edited.pdf',
      bytes: runRedactCase('per-annotation', fontBytes).savedBytes,
    },
  ];
}
