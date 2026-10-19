import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
// core 를 mupdf 보다 먼저 import 한다(src/wasm-module.ts).
import { extractPageModel } from '../src/index.js';
import * as mupdf from 'mupdf';
import {
  formatMeasureTable,
  measureDocument,
  type DocumentMeasure,
  type ModelProvider,
} from '@pdf-editor/pdf-ops/measure';

/**
 * 실제 core extractPage 로 하는 코퍼스 매칭 측정(docs/m1-contract.md 6절 3). 환경 변수가 없으면 건너뛴다.
 *
 *   CORE_LINK_MEASURE_DIR=<PDF 폴더>  [CORE_LINK_MEASURE_OUT=<결과 경로, 확장자 없이>]
 *   pnpm --filter @pdf-editor/core exec vitest run test/corpus-link.test.ts
 *
 * core 는 계약 3.1 확정 규칙(first-arrival)만 구현하므로 그 정책만 잰다. no-clip 비교는 pdf-ops 러너
 * (test/corpus-measure.test.ts, 테스트 헬퍼 PageModel)로 잰다.
 */
const dir = process.env.CORE_LINK_MEASURE_DIR;
const out = process.env.CORE_LINK_MEASURE_OUT;

const coreProvider: ModelProvider = (doc, pageIndex, policy) => {
  if (policy !== 'first-arrival') throw new Error(`core 는 first-arrival 만 구현: ${policy}`);
  const page = doc.loadPage(pageIndex);
  try {
    return extractPageModel(page, { pageIndex });
  } finally {
    page.destroy();
  }
};

function pdfFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.toLowerCase().endsWith('.pdf')) found.push(p);
    }
  };
  walk(root);
  return found;
}

describe.skipIf(!dir)('코퍼스 매칭 측정: 실제 core extractPage(CORE_LINK_MEASURE_DIR)', () => {
  it('문서별 실패 쪽·미매칭 글자', () => {
    const docs: DocumentMeasure[] = [];
    const openErrors: { file: string; message: string }[] = [];
    for (const path of pdfFiles(dir!)) {
      const file = relative(dir!, path);
      let doc: mupdf.PDFDocument;
      try {
        doc = mupdf.Document.openDocument(
          readFileSync(path),
          'application/pdf',
        ) as mupdf.PDFDocument;
      } catch (e) {
        openErrors.push({ file, message: e instanceof Error ? e.message : String(e) });
        continue;
      }
      docs.push(measureDocument(file, doc, coreProvider, ['first-arrival']));
      doc.destroy();
    }
    const table = formatMeasureTable(docs);
    if (out) {
      writeFileSync(
        `${out}.json`,
        JSON.stringify({ measuredAt: new Date().toISOString(), docs, openErrors }, null, 2),
      );
      writeFileSync(`${out}.md`, table);
    } else {
      process.stdout.write(table);
    }
    expect(docs.length + openErrors.length).toBeGreaterThan(0);
  }, 3_600_000);
});
