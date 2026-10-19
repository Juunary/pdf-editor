import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// core 를 mupdf 보다 먼저 import 한다(src/wasm-module.ts).
import { extractPageModel, openPdf } from '../src/index.js';
import type * as mupdf from 'mupdf';
import {
  fingerprintText,
  reconstructPage,
  scoreLayout,
  summarizeScores,
  type PageLabel,
  type PageScore,
} from '@pdf-editor/layout-recon';

/**
 * M2 정확도 하네스(docs/m2-contract.md 4절). 환경 변수가 없으면 건너뛴다.
 *
 *   LAYOUT_CORPUS_DIR=<코퍼스 PDF 폴더> [LAYOUT_ACC_OUT=<결과 JSON 경로>] [LAYOUT_ACC_SPLIT=dev|test|all]
 *   pnpm --filter @pdf-editor/core exec vitest run test/layout-accuracy.test.ts
 *
 * 라벨은 fixtures/labels/<문서 id>/pNNN.json. reviewed·confirmed 라벨만 채점한다. 추출 지문이 다르면
 * 그 쪽은 채점하지 않고 실패로 보고한다(추출이 바뀌면 라벨을 다시 확인해야 한다).
 * 기본은 dev 만 채점한다(계약 4.4: test 는 마일스톤 끝에 명시적으로 LAYOUT_ACC_SPLIT=test|all 로 한 번).
 * layout-recon 은 vitest.config.ts 별칭으로 소스를 쓴다. 결과에 커밋 SHA·작업 트리 변경 여부를 남긴다.
 * test 요약은 전체(test)와 문서 단위 보류(test-docs-unseen: dev 쪽이 없는 문서의 test 쪽)로 나눠 낸다.
 * 역할 채점(docs/m2-accuracy.md 7절 W4-1): 요약의 roles(역할별 정밀도·재현율)·roleMatrix(혼동표)·rolePairs,
 * 쪽별 score.roles·roleMisses(짝지은 쌍 중 역할이 다른 것)를 결과 JSON 에 남긴다. 목표치는 없다.
 */
/**
 * 최종 측정 전까지 복원 알고리즘을 한 번도 실행하지 않은 문서(A7-10 보강, docs/m2-contract.md 4.4).
 * 개발 중 예측을 본 적이 없는 깨끗한 보류 세트로 따로 요약한다.
 */
const UNPROCESSED_DOCS = new Set([
  'kogl-nabo-rnd107',
  'kogl-nabo-finstmt2025',
  'kogl-mods-cpi-202609',
  'jnl-phwr-2025-18-36-1',
  'jnl-jdis-2026-2-2-7',
]);

const corpus = process.env.LAYOUT_CORPUS_DIR;
const out = process.env.LAYOUT_ACC_OUT;
const split = process.env.LAYOUT_ACC_SPLIT ?? 'dev';

function gitState(): { sha: string; dirty: boolean } {
  try {
    const root = resolve(labelsDir, '../..');
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
    const status = execFileSync(
      'git',
      ['status', '--porcelain', '--', 'packages', 'fixtures/labels'],
      {
        cwd: root,
      },
    )
      .toString()
      .trim();
    return { sha, dirty: status !== '' };
  } catch {
    return { sha: 'unknown', dirty: true };
  }
}
const labelsDir = resolve(import.meta.dirname, '../../../fixtures/labels');

interface PageRow {
  name: string;
  split: string;
  status: string;
  doc: string;
  score: PageScore;
  reconMs: number;
}

describe.skipIf(!corpus)('M2 정확도 하네스', () => {
  it('정답 라벨 채점', { timeout: 600_000 }, () => {
    const rows: PageRow[] = [];
    const stale: string[] = [];
    const docs = new Map<string, mupdf.PDFDocument>();
    try {
      for (const doc of readdirSync(labelsDir).sort()) {
        for (const file of readdirSync(join(labelsDir, doc)).sort()) {
          const label = JSON.parse(readFileSync(join(labelsDir, doc, file), 'utf8')) as PageLabel;
          if (label.status === 'draft') continue;
          if (split !== 'all' && label.split !== split) continue;
          const pdfPath = join(corpus!, `${label.doc}.pdf`);
          const name = `${label.doc}/${file}`;
          if (!existsSync(pdfPath)) {
            stale.push(`${name}: PDF 없음`);
            continue;
          }
          let pdf = docs.get(label.doc);
          if (!pdf) {
            pdf = openPdf(new Uint8Array(readFileSync(pdfPath)));
            docs.set(label.doc, pdf);
          }
          const page = pdf.loadPage(label.pageIndex);
          let model;
          try {
            model = extractPageModel(page, {
              pageIndex: label.pageIndex,
              includePathSegments: true,
            });
          } finally {
            page.destroy();
          }
          const sha = createHash('sha256').update(fingerprintText(model), 'utf8').digest('hex');
          if (sha !== label.extract.linesSha256 || model.lines.length !== label.extract.lineCount) {
            stale.push(`${name}: 추출 지문 불일치`);
            continue;
          }
          // 이웃 쪽(±1·±2)은 경로 없이 추출해 반복 판정에만 쓴다(core getPageLayout 과 같은 입력).
          const neighbors = [-2, -1, 1, 2]
            .map((k) => label.pageIndex + k)
            .filter((n) => n >= 0 && n < pdf!.countPages())
            .map((n) => {
              const np = pdf!.loadPage(n);
              try {
                return extractPageModel(np, { pageIndex: n });
              } finally {
                np.destroy();
              }
            });
          const layout = reconstructPage(model, { neighbors });
          rows.push({
            name,
            split: label.split,
            status: label.status,
            doc: label.doc,
            score: scoreLayout(label, layout),
            reconMs: layout.reconMs,
          });
        }
      }
    } finally {
      for (const d of docs.values()) d.destroy();
    }
    const devDocs = new Set<string>();
    for (const doc of readdirSync(labelsDir))
      for (const file of readdirSync(join(labelsDir, doc))) {
        const l = JSON.parse(readFileSync(join(labelsDir, doc, file), 'utf8')) as PageLabel;
        if (l.split === 'dev') devDocs.add(l.doc);
      }
    const groups: Record<string, (r: PageRow) => boolean> = {
      dev: (r) => r.split === 'dev',
      test: (r) => r.split === 'test',
      'test-docs-unseen': (r) => r.split === 'test' && !devDocs.has(r.doc),
      'test-unprocessed': (r) => r.split === 'test' && UNPROCESSED_DOCS.has(r.doc),
      test2: (r) => r.split === 'test2',
      all: () => true,
    };
    const summaries = Object.fromEntries(
      Object.entries(groups)
        .filter(
          ([s]) => split === 'all' || s === split || (split === 'test' && s.startsWith('test')),
        )
        .map(([s, pick]) => [s, summarizeScores(rows.filter(pick).map((r) => r.score))]),
    );
    if (out) {
      writeFileSync(
        out,
        JSON.stringify(
          {
            labelsDir,
            split,
            git: gitState(),
            measuredAt: new Date().toISOString(),
            summaries,
            stale,
            reconMs: {
              max: Math.max(...rows.map((r) => r.reconMs)),
              mean: rows.reduce((a, r) => a + r.reconMs, 0) / Math.max(rows.length, 1),
            },
            pages: rows,
          },
          null,
          1,
        ),
      );
    }
    expect(stale).toEqual([]);
    expect(rows.length).toBeGreaterThan(0);
  });
});
