/**
 * 재적용 회귀(R4, docs/m5-followup.md): 코퍼스 쪽에서 서로 다른 문단을 차례로 고친 뒤(다 쓰면 편집 블록을 차례로 다시 고침)
 * 같은 로그를 새 세션에 재적용해 끝까지 성공하고 쪽 텍스트가 원래 편집 결과와 같은지 본다.
 * `tools/bench/journal-child.mjs <pdf> <쪽> <N> distinct` 와 같은 편집 열이다.
 *
 * 환경 변수가 없으면 건너뛴다.
 *   REPLAY_CORPUS_DIR=<PDF 폴더> pnpm --filter @pdf-editor/core exec vitest run test/replay-corpus.test.ts
 *   REPLAY_CORPUS_LONG=1 을 더하면 kogl-mods-cpi-202609 9쪽 100건(약 8분)도 돈다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EditOp } from '@pdf-editor/shared-types';
import { PdfSession } from '../src/index.js';
import { FONT_BYTES } from './edit-harness.js';

const dir = process.env.REPLAY_CORPUS_DIR;
const long = process.env.REPLAY_CORPUS_LONG === '1';

const pageText = (s: PdfSession, pageIndex: number): string =>
  s
    .extractPage({ pageIndex })
    .chars.map((c) => c.text)
    .join('');

async function distinctEdits(
  bytes: Uint8Array,
  page: number,
  n: number,
): Promise<{ ops: EditOp[]; text: string }> {
  const s = new PdfSession({ loadFallbackFont: async () => FONT_BYTES });
  s.open(bytes);
  const ops: EditOp[] = [];
  let blockTurn = 0;
  try {
    for (let i = 0; i < n; i++) {
      const paras = (await s.getPageEditability(page)).paragraphs.filter((p) => p.editable);
      let cur = paras.find((p) => p.editedBlock === null);
      if (!cur) {
        const blocks = paras.filter((p) => p.editedBlock !== null);
        cur = blocks[blockTurn++ % Math.max(1, blocks.length)];
      }
      if (!cur) throw new Error(`${i}회: 편집할 문단 없음`);
      const plan = await s.planParagraphEdit(page, cur.paragraphId);
      const started = await s.beginParagraphEdit(page, cur.paragraphId, plan.revision);
      const base = plan.runs.map((r) => r.text).join('');
      await s.updateParagraphDraft(started.draftId, {
        runs: [{ text: `${base.replace(/ #\d+$/, '')} #${i + 1}`, style: plan.runs[0]!.style }],
        format: plan.format,
        composition: null,
        renderScale: 1.5,
      });
      ops.push((await s.commitParagraphEdit(started.draftId)).op);
    }
    return { ops, text: pageText(s, page) };
  } finally {
    s.close();
  }
}

const cases = [
  { file: 'zen-ko-report-21333257.pdf', page: 5, n: 20, long: false },
  { file: 'kogl-mods-cpi-202609.pdf', page: 8, n: 100, long: true },
];

describe.skipIf(!dir)('코퍼스 재적용 회귀(R4)', () => {
  for (const c of cases) {
    it.skipIf(c.long && !long)(
      `${c.file} ${c.page + 1}쪽 서로 다른 문단 ${c.n}건 재적용`,
      async () => {
        const path = join(dir!, c.file);
        if (!existsSync(path)) throw new Error(`코퍼스 파일 없음: ${path}`);
        const bytes = new Uint8Array(readFileSync(path));
        const live = await distinctEdits(bytes, c.page, c.n);
        expect(live.ops).toHaveLength(c.n);
        const r = new PdfSession({ loadFallbackFont: async () => FONT_BYTES });
        r.open(bytes);
        try {
          const history = await r.replayEdits(live.ops);
          expect(history.edits).toBe(c.n);
          expect(pageText(r, c.page)).toBe(live.text);
        } finally {
          r.close();
        }
      },
      c.long ? 1_800_000 : 120_000,
    );
  }
});
