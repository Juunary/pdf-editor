/**
 * Development accuracy measurement (only when the environment variable LAYOUT_DEV_MODELS is set). Scores PageModel JSON dumped beforehand with core and
 * fixtures/labels and writes the result to LAYOUT_DEV_OUT. The official harness is core's layout-accuracy test.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PageModel } from '@pdf-editor/shared-types';
import { scoreLayout, summarizeScores, type PageLabel } from '../src/accuracy.js';
import { fingerprintText } from '../src/features.js';
import { reconstructPage } from '../src/reconstruct.js';

const MODELS = process.env.LAYOUT_DEV_MODELS;
const LABELS =
  process.env.LAYOUT_DEV_LABELS ?? path.resolve(import.meta.dirname, '../../../fixtures/labels');
const OUT = process.env.LAYOUT_DEV_OUT;
const SPLIT = process.env.LAYOUT_DEV_SPLIT ?? 'dev';

describe.skipIf(!MODELS)('accuracy development measurement', () => {
  it('scores labeled pages', () => {
    const rows: Record<string, unknown>[] = [];
    const scores = [];
    for (const doc of fs.readdirSync(LABELS).sort()) {
      for (const f of fs.readdirSync(path.join(LABELS, doc)).sort()) {
        const label = JSON.parse(fs.readFileSync(path.join(LABELS, doc, f), 'utf8')) as PageLabel;
        // Draft labels are not scored (contract 4.1).
        if (label.status === 'draft' && process.env.LAYOUT_DEV_INCLUDE_DRAFT !== '1') continue;
        // test and test2 are not opened in development measurement (contract 4.4).
        if (label.split !== 'dev' && SPLIT === 'dev') continue;
        if (SPLIT !== 'all' && label.split !== SPLIT) continue;
        const name = `${doc}-${f.replace('.json', '')}`;
        const file = path.join(MODELS!, `${name}.json`);
        if (!fs.existsSync(file)) continue;
        const model = JSON.parse(fs.readFileSync(file, 'utf8')) as PageModel;
        const sha = createHash('sha256').update(fingerprintText(model), 'utf8').digest('hex');
        if (sha !== label.extract.linesSha256) {
          rows.push({ name, stale: true });
          continue;
        }
        // Pass neighboring-page (±1, ±2) dumps if present (LAYOUT_DEV_NEIGHBORS directory).
        const nbDir = process.env.LAYOUT_DEV_NEIGHBORS;
        const neighbors: PageModel[] = [];
        if (nbDir)
          for (const k of [-2, -1, 1, 2]) {
            const nf = path.join(
              nbDir,
              `${doc}-p${String(label.pageIndex + k).padStart(3, '0')}.json`,
            );
            if (fs.existsSync(nf))
              neighbors.push(JSON.parse(fs.readFileSync(nf, 'utf8')) as PageModel);
          }
        const layout = reconstructPage(model, { neighbors });
        const s = scoreLayout(label, layout);
        scores.push(s);
        rows.push({ name, status: label.status, ...s, ms: Math.round(layout.reconMs) });
      }
    }
    const summary = summarizeScores(scores);
    if (OUT) fs.writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 1));
    expect(scores.length).toBeGreaterThan(0);
  });
});
