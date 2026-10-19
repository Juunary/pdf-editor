import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// core 를 mupdf 보다 먼저 import 한다(src/wasm-module.ts).
import { extractPageModel, openPdf } from '../src/index.js';
import * as mupdf from 'mupdf';
import { reconstructPage } from '@pdf-editor/layout-recon';
import type { PageLayout, PageModel } from '@pdf-editor/shared-types';

/**
 * 코퍼스 전수 복원 점검(docs/m2-contract.md 2.1 불변식·예외·시간). 환경 변수가 없으면 건너뛴다.
 *
 *   LAYOUT_SWEEP_DIR=<코퍼스 PDF 폴더> [LAYOUT_SWEEP_OUT=<결과 JSON>] [LAYOUT_SWEEP_LIMIT=<문서당 최대 쪽>]
 *   pnpm --filter @pdf-editor/core exec vitest run test/layout-sweep.test.ts
 */
const dir = process.env.LAYOUT_SWEEP_DIR;
const out = process.env.LAYOUT_SWEEP_OUT;
const limit = Number(process.env.LAYOUT_SWEEP_LIMIT ?? Infinity);

/** 불변식 위반 목록(빈 배열이면 통과). */
export function invariantViolations(model: PageModel, layout: PageLayout): string[] {
  const v: string[] = [];
  const count = new Map<number, number>();
  layout.paragraphs.forEach((p, i) => {
    if (p.id !== i) v.push(`문단 id ${p.id} != ${i}`);
    for (const l of p.lines) count.set(l, (count.get(l) ?? 0) + 1);
    const chars = p.lines.flatMap((l) => model.lines[l]!.chars);
    if (chars.length !== p.chars.length || chars.some((c, k) => c !== p.chars[k]))
      v.push(`문단 ${i} chars 불일치`);
    let pos = 0;
    for (const r of p.styleRuns) {
      if (r.start !== pos || r.end <= r.start) v.push(`문단 ${i} 모양 구간 빈틈`);
      pos = r.end;
    }
    if (pos !== p.chars.length) v.push(`문단 ${i} 모양 구간 끝 ${pos} != ${p.chars.length}`);
  });
  model.lines.forEach((line, i) => {
    const visible = line.chars.some((c) => model.chars[c]!.text.trim() !== '');
    const n = count.get(i) ?? 0;
    if (visible && n !== 1) v.push(`줄 ${i} 소속 ${n}`);
    if (!visible && n !== 0) v.push(`빈 줄 ${i} 이 문단에 있음`);
  });
  const top = layout.readingOrder.map((r) => `${r.kind}:${r.id}`);
  if (new Set(top).size !== top.length) v.push('읽기 순서 중복');
  for (const p of layout.paragraphs) {
    const inTop = top.includes(`paragraph:${p.id}`);
    if (inTop !== (p.table === null && p.figure === null)) v.push(`문단 ${p.id} 최상위 소속 오류`);
  }
  for (const t of layout.tables) if (!top.includes(`table:${t.id}`)) v.push(`표 ${t.id} 순서 없음`);
  for (const f of layout.figures)
    if (!top.includes(`figure:${f.id}`)) v.push(`도형 ${f.id} 순서 없음`);
  return v;
}

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
        for (let i = 0; i < n; i++) {
          const page = doc.loadPage(i);
          try {
            const model = extractPageModel(page, { pageIndex: i, includePathSegments: true });
            const layout = reconstructPage(model);
            const v = invariantViolations(model, layout);
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
