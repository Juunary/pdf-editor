import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import type { Rect } from '@pdf-editor/shared-types';
import { buildSourceMap, removeTextShowOps } from '../src/index.js';

/**
 * A7-2 real-document comparison (docs/m1-decisions.md). Skipped when the environment variable is absent.
 *   TEXT_REMOVE_CORPUS_DIR=<PDF folder> [TEXT_REMOVE_OUT=<json path>] [TEXT_REMOVE_PAGES=<file:page,...>]
 * On each page, picks multi-line structured text blocks and erases them with (A) SourceMap-based removal and (B) MuPDF per-annotation redaction,
 * then measures the number of differing render pixels outside the block (2px margin) and the number of characters remaining inside the block.
 */
const dir = process.env.TEXT_REMOVE_CORPUS_DIR;
const out = process.env.TEXT_REMOVE_OUT;
const SCALE = 2;

type Doc = mupdf.PDFDocument;
const open = (b: Uint8Array) => mupdf.Document.openDocument(b, 'application/pdf') as Doc;

function blocksOf(doc: Doc, p: number): { bbox: Rect; lines: number }[] {
  const blocks: { bbox: Rect; lines: number }[] = [];
  let cur: { bbox: Rect; lines: number } | null = null;
  const page = doc.loadPage(p);
  const st = page.toStructuredText('preserve-whitespace');
  st.walk({
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
  st.destroy();
  page.destroy();
  return blocks;
}

const inside = (r: Rect, x: number, y: number, m = 1) =>
  x >= r[0] - m && x <= r[2] + m && y >= r[1] - m && y <= r[3] + m;

function render(doc: Doc, p: number): mupdf.Pixmap {
  const page = doc.loadPage(p);
  try {
    return page.toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceRGB, false, true);
  } finally {
    page.destroy();
  }
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
  const page = doc.loadPage(p);
  const st = page.toStructuredText('');
  st.walk({
    onChar: (c, origin) => {
      if (c.trim() && inside(r, origin[0], origin[1], 0.5)) n++;
    },
  });
  st.destroy();
  page.destroy();
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

/** Copies the bytes after a full save and releases the MuPDF buffer. */
function saveBytes(doc: Doc): Uint8Array {
  const buf = doc.saveToBuffer('garbage=yes,compress');
  try {
    return buf.asUint8Array().slice();
  } finally {
    buf.destroy();
  }
}

function evaluate(file: string, bytes: Uint8Array, p: number, block: { bbox: Rect }): Row | null {
  const owned: { destroy(): void }[] = [];
  const keep = <T extends { destroy(): void }>(x: T): T => {
    owned.push(x);
    return x;
  };
  try {
    const doc = keep(open(bytes));
    const map = buildSourceMap(doc, p);
    // Page content text operations that hold only glyphs inside the block
    const ops = map.ops.filter(
      (o) =>
        o.kind === 'text-show' &&
        o.formPath.length === 0 &&
        (o.text?.glyphs.length ?? 0) > 0 &&
        o.text!.glyphs.every((g) => inside(block.bbox, g.origin[0], g.origin[1])),
    );
    if (ops.length === 0) return null;
    const before = keep(render(doc, p));
    const r = removeTextShowOps(
      doc,
      map,
      ops.map((o) => o.id),
    );
    const a = keep(open(saveBytes(doc)));
    const sourceMap = {
      removed: r.removed.length,
      skipped: r.skipped.length,
      diffOutside: diffOutside(before, keep(render(a, p)), block.bbox),
      charsLeft: charsInside(a, p, block.bbox),
    };
    const warnings: string[] = [];
    mupdf.setLog({ warning: (m) => warnings.push(m), error: (m) => warnings.push(m) });
    const d2 = keep(open(bytes));
    const page = keep(d2.loadPage(p) as mupdf.PDFPage);
    const annot = page.createAnnotation('Redact');
    annot.setRect(block.bbox);
    annot.applyRedaction(0, 0, 0, 0);
    const b = keep(open(saveBytes(d2)));
    mupdf.setLog(null);
    return {
      file,
      page: p,
      bbox: block.bbox,
      ops: ops.length,
      sourceMap,
      redaction: {
        diffOutside: diffOutside(before, keep(render(b, p)), block.bbox),
        charsLeft: charsInside(b, p, block.bbox),
        warnings: [...new Set(warnings)].slice(0, 5),
      },
    };
  } finally {
    mupdf.setLog(null);
    for (const x of owned.reverse()) x.destroy();
    // Empties the font/image caches that accumulate per document to prevent WASM heap exhaustion.
    mupdf.emptyStore();
  }
}

describe.skipIf(!dir)(
  'A7-2 real documents: SourceMap removal vs MuPDF redaction (TEXT_REMOVE_CORPUS_DIR)',
  () => {
    it('render difference outside the block and characters remaining inside the block', () => {
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
        const probe = open(bytes);
        const count = probe.countPages();
        probe.destroy();
        for (const p of pages.filter((x) => x < count)) {
          // Prefer multi-line blocks. An output tool that splits blocks per line (docs/m0-corpus-recheck.md C5) uses a wide one-line block.
          const listing = open(bytes);
          const all = blocksOf(listing, p);
          listing.destroy();
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
