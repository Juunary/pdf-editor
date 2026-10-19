import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import {
  formatMeasureTable,
  measureDocument,
  type DocumentMeasure,
  type GlyphSeqPolicy,
} from '../src/measure.js';
import { buildTestPageModel } from './helpers/page-model.js';

/**
 * 코퍼스 매칭 측정 러너(docs/m1-pdf-ops.md 5.5절). 환경 변수가 없으면 건너뛴다.
 *
 *   LINK_MEASURE_DIR=<PDF 폴더>  [LINK_MEASURE_OUT=<결과 경로, 확장자 없이>]  [LINK_MEASURE_POLICIES=first-arrival,no-clip]
 *   pnpm --filter @pdf-editor/pdf-ops exec vitest run test/corpus-measure.test.ts
 *
 * 결과: <OUT>.json(문서별·정책별 요약, 실패 쪽 번호, 쪽 예외)과 <OUT>.md(표). OUT 이 없으면 표를 표준 출력에 쓴다.
 * PageModel 은 테스트 헬퍼(MuPDF Device, 계약 3.1 판정)로 만든다. core extractPage 로 측정하려면
 * `@pdf-editor/pdf-ops/measure` 의 measureDocument 에 core 를 감싼 ModelProvider 를 넘긴다.
 */
const dir = process.env.LINK_MEASURE_DIR;
const out = process.env.LINK_MEASURE_OUT;
const policies = (process.env.LINK_MEASURE_POLICIES ?? 'first-arrival,no-clip').split(
  ',',
) as GlyphSeqPolicy[];

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

describe.skipIf(!dir)('코퍼스 매칭 측정(LINK_MEASURE_DIR)', () => {
  it('문서별·정책별 실패 쪽·글리프 수', () => {
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
      // doc.destroy() 는 하지 않는다: 남은 PDFObject 래퍼의 나중 정리가 해제된 문서에 접근할 수 있다.
      docs.push(measureDocument(file, doc, buildTestPageModel, policies));
    }
    const table = formatMeasureTable(docs);
    if (out) {
      writeFileSync(
        `${out}.json`,
        JSON.stringify(
          { measuredAt: new Date().toISOString(), policies, docs, openErrors },
          null,
          2,
        ),
      );
      writeFileSync(`${out}.md`, table);
    } else {
      process.stdout.write(table);
    }
    expect(docs.length + openErrors.length).toBeGreaterThan(0);
  }, 3_600_000);
});
