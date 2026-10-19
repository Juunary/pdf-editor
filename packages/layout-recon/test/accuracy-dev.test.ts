/**
 * 개발용 정확도 측정(환경 변수 LAYOUT_DEV_MODELS 가 있을 때만). core 로 미리 덤프한 PageModel JSON 과
 * fixtures/labels 를 채점해 LAYOUT_DEV_OUT 에 쓴다. 정식 하네스는 core 의 layout-accuracy 시험이다.
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

describe.skipIf(!MODELS)('정확도 개발 측정', () => {
  it('라벨 쪽 채점', () => {
    const rows: Record<string, unknown>[] = [];
    const scores = [];
    for (const doc of fs.readdirSync(LABELS).sort()) {
      for (const f of fs.readdirSync(path.join(LABELS, doc)).sort()) {
        const label = JSON.parse(fs.readFileSync(path.join(LABELS, doc, f), 'utf8')) as PageLabel;
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
        const layout = reconstructPage(model);
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
