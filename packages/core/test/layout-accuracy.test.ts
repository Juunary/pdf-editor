import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// Import core before mupdf (src/wasm-module.ts).
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
 * M2 accuracy harness (docs/m2-contract.md section 4). Skipped when the environment variable is not set.
 *
 *   LAYOUT_CORPUS_DIR=<corpus PDF folder> [LAYOUT_ACC_OUT=<result JSON path>] [LAYOUT_ACC_SPLIT=dev|test|all]
 *   pnpm --filter @pdf-editor/core exec vitest run test/layout-accuracy.test.ts
 *
 * Labels are fixtures/labels/<document id>/pNNN.json. Only reviewed and confirmed labels are scored. If the extraction fingerprint differs,
 * that page is not scored and is reported as a failure (if extraction changes, the labels must be rechecked).
 * By default only dev is scored (contract 4.4: test is run once at the end of a milestone, explicitly with LAYOUT_ACC_SPLIT=test|all).
 * layout-recon uses the source through an alias in vitest.config.ts. The result records the commit SHA and whether the working tree has changes.
 * The test summary is split into the whole (test) and a document-level holdout (test-docs-unseen: the test pages of documents that have no dev pages).
 * Role scoring (docs/m2-accuracy.md section 7, W4-1): the summary's roles (precision/recall per role), roleMatrix (confusion matrix) and rolePairs,
 * and per-page score.roles and roleMisses (matched pairs whose roles differ) are recorded in the result JSON. There is no target value.
 */
/**
 * Documents on which the reconstruction algorithm was never run before the final measurement (A7-10 reinforcement, docs/m2-contract.md 4.4).
 * They are summarized separately as a clean holdout set whose predictions were never seen during development.
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

describe.skipIf(!corpus)('M2 accuracy harness', () => {
  it('scoring against ground-truth labels', { timeout: 600_000 }, () => {
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
          // Neighbor pages (±1, ±2) are extracted without paths and used only for the repetition check (same input as core getPageLayout).
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
