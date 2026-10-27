import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Import core before mupdf (src/wasm-module.ts).
import { extractPageModel, openPdf } from '../src/index.js';
import * as mupdf from 'mupdf';
import type { PageModel } from '@pdf-editor/shared-types';
// Invariant checker (cell/paragraph mutual consistency, shape labels, grid coverage, including non-finite numbers).
import { reconstructPage, validateLayout } from '@pdf-editor/layout-recon';

/**
 * Full-corpus reconstruction check (docs/m2-contract.md 2.1: invariants, exceptions, time). Skipped when the environment variable is not set.
 *
 *   LAYOUT_SWEEP_DIR=<corpus PDF folder> [LAYOUT_SWEEP_OUT=<result JSON>] [LAYOUT_SWEEP_LIMIT=<max pages per document>]
 *   pnpm --filter @pdf-editor/core exec vitest run test/layout-sweep.test.ts
 */
const dir = process.env.LAYOUT_SWEEP_DIR;
const out = process.env.LAYOUT_SWEEP_OUT;
const limit = Number(process.env.LAYOUT_SWEEP_LIMIT ?? Infinity);

describe.skipIf(!dir)('full-corpus reconstruction check', () => {
  it('exceptions, invariants, time', { timeout: 3_600_000 }, () => {
    const pages: {
      doc: string;
      page: number;
      ms: number;
      paragraphs: number;
      tables: number;
      figures: number;
    }[] = [];
    const failures: string[] = [];
    for (const name of readdirSync(dir!)
      .filter((f) => f.endsWith('.pdf'))
      .sort()) {
      const doc = openPdf(new Uint8Array(readFileSync(join(dir!, name))));
      try {
        const n = Math.min(doc.countPages(), limit);
        // Neighbor page (extraction without paths) window cache: do not re-extract the ±2 pages for every page.
        const plain = new Map<number, PageModel>();
        const plainModel = (k: number): PageModel => {
          let m = plain.get(k);
          if (!m) {
            const p = doc.loadPage(k);
            try {
              m = extractPageModel(p, { pageIndex: k });
            } finally {
              p.destroy();
            }
            plain.set(k, m);
          }
          return m;
        };
        for (let i = 0; i < n; i++) {
          for (const k of [...plain.keys()]) if (k < i - 2) plain.delete(k);
          const page = doc.loadPage(i);
          try {
            const model = extractPageModel(page, { pageIndex: i, includePathSegments: true });
            const neighbors = [-2, -1, 1, 2]
              .map((k) => i + k)
              .filter((k) => k >= 0 && k < doc.countPages())
              .map(plainModel);
            const layout = reconstructPage(model, { neighbors });
            const v = validateLayout(model, layout);
            if (v.length) failures.push(`${name}:${i}: ${v.slice(0, 3).join('; ')}`);
            pages.push({
              doc: name,
              page: i,
              ms: layout.reconMs,
              paragraphs: layout.paragraphs.length,
              tables: layout.tables.length,
              figures: layout.figures.length,
            });
          } catch (e) {
            failures.push(`${name}:${i}: 예외 ${(e as Error).message}`);
          } finally {
            page.destroy();
          }
        }
      } finally {
        doc.destroy();
        mupdf.emptyStore();
      }
    }
    const ms = pages.map((p) => p.ms).sort((a, b) => a - b);
    const summary = {
      pages: pages.length,
      failures: failures.length,
      msMedian: ms[ms.length >> 1] ?? 0,
      msP99: ms[Math.floor(ms.length * 0.99)] ?? 0,
      msMax: ms.at(-1) ?? 0,
      slowest: [...pages].sort((a, b) => b.ms - a.ms).slice(0, 5),
      tables: pages.reduce((a, p) => a + p.tables, 0),
      figures: pages.reduce((a, p) => a + p.figures, 0),
      paragraphs: pages.reduce((a, p) => a + p.paragraphs, 0),
    };
    if (out) writeFileSync(out, JSON.stringify({ summary, failures }, null, 1));
    expect(failures).toEqual([]);
  });
});
