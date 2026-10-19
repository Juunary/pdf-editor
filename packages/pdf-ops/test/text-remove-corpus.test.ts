import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import type { Rect } from '@pdf-editor/shared-types';
import { buildSourceMap, removeTextShowOps } from '../src/index.js';

/**
 * A7-2 실제 문서 비교(docs/m1-decisions.md). 환경 변수가 없으면 건너뛴다.
 *   TEXT_REMOVE_CORPUS_DIR=<PDF 폴더> [TEXT_REMOVE_OUT=<json 경로>] [TEXT_REMOVE_PAGES=<파일:쪽,...>]
 * 쪽마다 여러 줄 구조화 텍스트 블록을 골라 (A) SourceMap 기반 제거, (B) MuPDF 주석 단위 redaction 으로 각각
 * 지운 뒤, 블록 밖(여백 2px) 렌더 차이 픽셀 수와 블록 안에 남은 글자 수를 잰다.
 */
const dir = process.env.TEXT_REMOVE_CORPUS_DIR;
const out = process.env.TEXT_REMOVE_OUT;
const SCALE = 2;

type Doc = mupdf.PDFDocument;
const open = (b: Uint8Array) => mupdf.Document.openDocument(b, 'application/pdf') as Doc;

function blocksOf(doc: Doc, p: number): { bbox: Rect; lines: number }[] {
  const blocks: { bbox: Rect; lines: number }[] = [];
  let cur: { bbox: Rect; lines: number } | null = null;
  doc
    .loadPage(p)
    .toStructuredText('preserve-whitespace')
    .walk({
      beginTextBlock: (bbox) => {
        cur = { bbox: [bbox[0], bbox[1], bbox[2], bbox[3]], lines: 0 };
      },
      beginLine: () => {
        if (cur) cur.lines++;
      },
      endTextBlock: () => {
        if (cur) blocks.push(cur);
        cur = null;
      },
    });
  return blocks;
}

const inside = (r: Rect, x: number, y: number, m = 1) =>
  x >= r[0] - m && x <= r[2] + m && y >= r[1] - m && y <= r[3] + m;

function render(doc: Doc, p: number): mupdf.Pixmap {
  return doc
    .loadPage(p)
    .toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceRGB, false, true);
}

function diffOutside(a: mupdf.Pixmap, b: mupdf.Pixmap, r: Rect): number {
  const w = a.getWidth();
  const h = a.getHeight();
  if (b.getWidth() !== w || b.getHeight() !== h) return -1;
  const pa = a.getPixels();
  const pb = b.getPixels();
  const n = a.getNumberOfComponents();
  const x0 = r[0] * SCALE - 2;
  const y0 = r[1] * SCALE - 2;
  const x1 = r[2] * SCALE + 2;
  const y1 = r[3] * SCALE + 2;
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
      const i = (y * w + x) * n;
      for (let c = 0; c < n; c++) {
        if (Math.abs(pa[i + c]! - pb[i + c]!) > 8) {
          count++;
          break;
        }
      }
    }
  }
  return count;
}

function charsInside(doc: Doc, p: number, r: Rect): number {
  let n = 0;
  doc
    .loadPage(p)
    .toStructuredText('')
    .walk({
      onChar: (c, origin) => {
        if (c.trim() && inside(r, origin[0], origin[1], 0.5)) n++;
      },
    });
  return n;
}

interface Row {
  file: string;
  page: number;
  bbox: Rect;
  ops: number;
  sourceMap: { removed: number; skipped: number; diffOutside: number; charsLeft: number };
  redaction: { diffOutside: number; charsLeft: number; warnings: string[] };
}

function evaluate(file: string, bytes: Uint8Array, p: number, block: { bbox: Rect }): Row | null {
  const doc = open(bytes);
  const map = buildSourceMap(doc, p);
  // 블록 안 글리프만 가진 페이지 콘텐츠 텍스트 연산
  const ops = map.ops.filter(
    (o) =>
      o.kind === 'text-show' &&
      o.formPath.length === 0 &&
      (o.text?.glyphs.length ?? 0) > 0 &&
      o.text!.glyphs.every((g) => inside(block.bbox, g.origin[0], g.origin[1])),
  );
  if (ops.length === 0) return null;
  const before = render(doc, p);
  const r = removeTextShowOps(
    doc,
    map,
    ops.map((o) => o.id),
  );
  const a = open(doc.saveToBuffer('garbage=yes,compress').asUint8Array().slice());
  const sourceMap = {
    removed: r.removed.length,
    skipped: r.skipped.length,
    diffOutside: diffOutside(before, render(a, p), block.bbox),
    charsLeft: charsInside(a, p, block.bbox),
  };
  const warnings: string[] = [];
  mupdf.setLog({ warning: (m) => warnings.push(m), error: (m) => warnings.push(m) });
  const d2 = open(bytes);
  const page = d2.loadPage(p) as mupdf.PDFPage;
  const annot = page.createAnnotation('Redact');
  annot.setRect(block.bbox);
  annot.applyRedaction(0, 0, 0, 0);
  const b = open(d2.saveToBuffer('garbage=yes,compress').asUint8Array().slice());
  mupdf.setLog(null);
  return {
    file,
    page: p,
    bbox: block.bbox,
    ops: ops.length,
    sourceMap,
    redaction: {
      diffOutside: diffOutside(before, render(b, p), block.bbox),
      charsLeft: charsInside(b, p, block.bbox),
      warnings: [...new Set(warnings)].slice(0, 5),
    },
  };
}

describe.skipIf(!dir)(
  'A7-2 실제 문서: SourceMap 제거 vs MuPDF redaction(TEXT_REMOVE_CORPUS_DIR)',
  () => {
    it('블록 밖 렌더 차이·블록 안 남은 글자', () => {
      const pagesEnv = process.env.TEXT_REMOVE_PAGES;
      const plan: { file: string; pages: number[] }[] = pagesEnv
        ? pagesEnv.split(',').map((s) => {
            const [file, page] = s.split(':');
            return { file: file!, pages: [Number(page)] };
          })
        : readdirSync(dir!)
            .filter((f) => f.endsWith('.pdf'))
            .sort()
            .map((file) => ({ file, pages: [1, 4] }));
      const rows: Row[] = [];
      for (const { file, pages } of plan) {
        const bytes = new Uint8Array(readFileSync(join(dir!, file)));
        const count = open(bytes).countPages();
        for (const p of pages.filter((x) => x < count)) {
          // 여러 줄 블록 우선. 줄마다 블록을 나누는 출력기(docs/m0-corpus-recheck.md C5)는 넓은 한 줄 블록을 쓴다.
          const all = blocksOf(open(bytes), p);
          const multi = all.filter((b) => b.lines >= 2);
          const blocks = (
            multi.length > 0
              ? multi
              : [...all].sort((x, y) => y.bbox[2] - y.bbox[0] - (x.bbox[2] - x.bbox[0]))
          ).slice(0, 3);
          for (const block of blocks) {
            try {
              const row = evaluate(file, bytes, p, block);
              if (row) rows.push(row);
            } catch (e) {
              process.stdout.write(`skip ${file} p${p}: ${String(e)}\n`);
            }
          }
        }
      }
      if (out)
        writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), rows }, null, 2));
      for (const r of rows) {
        process.stdout.write(
          `${r.file} p${r.page} ops=${r.ops} | SM removed=${r.sourceMap.removed} skipped=${r.sourceMap.skipped} diffOut=${r.sourceMap.diffOutside} left=${r.sourceMap.charsLeft} | RD diffOut=${r.redaction.diffOutside} left=${r.redaction.charsLeft} ${r.redaction.warnings.join(' / ')}\n`,
        );
      }
      expect(rows.length).toBeGreaterThan(0);
    }, 3_600_000);
  },
);
