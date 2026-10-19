import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// core 를 mupdf 보다 먼저 import 한다(src/wasm-module.ts).
import { extractPageModel, openPdf } from '../src/index.js';
import * as mupdf from 'mupdf';
import type { PageModel } from '@pdf-editor/shared-types';
// 불변식 검사기(셀·문단 상호 일치, 도형 라벨, 격자 덮음, 비유한 수 포함).
import { reconstructPage, validateLayout } from '@pdf-editor/layout-recon';

/**
 * 코퍼스 전수 복원 점검(docs/m2-contract.md 2.1 불변식·예외·시간). 환경 변수가 없으면 건너뛴다.
 *
 *   LAYOUT_SWEEP_DIR=<코퍼스 PDF 폴더> [LAYOUT_SWEEP_OUT=<결과 JSON>] [LAYOUT_SWEEP_LIMIT=<문서당 최대 쪽>]
 *   pnpm --filter @pdf-editor/core exec vitest run test/layout-sweep.test.ts
 */
const dir = process.env.LAYOUT_SWEEP_DIR;
const out = process.env.LAYOUT_SWEEP_OUT;
const limit = Number(process.env.LAYOUT_SWEEP_LIMIT ?? Infinity);

describe.skipIf(!dir)('코퍼스 전수 복원 점검', () => {
  it('예외·불변식·시간', { timeout: 3_600_000 }, () => {
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
        // 이웃 쪽(경로 없는 추출) 창 캐시: 쪽마다 ±2 쪽을 다시 추출하지 않는다.
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
