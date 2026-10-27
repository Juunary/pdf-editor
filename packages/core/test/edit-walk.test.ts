/**
 * Walks the edit engine through a random order of operations (commit, cancel, undo, redo, save) and checks at every step that the MuPDF journal and the core log stay in sync and
 * that the document characters equal the expected model.
 */
import { describe, expect, it } from 'vitest';
import type { PdfSession } from '../src/index.js';
import { begin, draftInput, harness, journal, text } from './edit-harness.js';

/** Starting characters of the page's original paragraphs (layout reading order). */
const ORIGINALS = ['Title Heading', 'first paragraph', 'Second paragraph'];

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Layout id of an original paragraph (characters not yet edited). An edited paragraph has new characters and cannot be found. */
function paragraphId(s: PdfSession, original: string): number | undefined {
  return s.getPageLayout(0).paragraphs.find((p) => p.text.startsWith(original))?.id;
}

describe('edit engine random-order walk', () => {
  it.each([1, 2, 3, 4, 5, 6])(
    'seed %i: journal, log and characters match at every step',
    async (seed) => {
      const { s } = harness();
      const next = lcg(seed);
      // Applied edits (undo stack) and undone edits (redo stack). fallback: an edit containing Hangul (uses the fallback font).
      type Applied = { k: number; fallback: boolean };
      const applied: Applied[] = [];
      let undone: Applied[] = [];
      let counter = 0;

      const check = async (label: string) => {
        const history = await s.getEditHistory();
        expect(history.edits, label).toBe(applied.length);
        expect(history.canUndo, label).toBe(applied.length > 0);
        expect(history.canRedo, label).toBe(undone.length > 0);
        expect(history.activeEditIds.length, label).toBe(applied.length);
        const j = journal(s);
        expect(j.position, label).toBe(applied.length);
        expect(j.steps.length, label).toBe(applied.length + undone.length);
        const t = text(s);
        ORIGINALS.forEach((original, k) => {
          const edited = applied.some((a) => a.k === k);
          expect(t.includes(original), `${label}: ${original}`).toBe(!edited);
        });
        const blocks = (await s.getPageEdits(0)).blocks;
        expect(blocks.length, label).toBe(applied.length);
      };

      await s.getPageEditability(0);
      await check('시작');
      for (let step = 0; step < 40; step++) {
        const pick = next();
        const free = [0, 1, 2].filter((k) => !applied.some((a) => a.k === k));
        if (pick < 0.35 && free.length > 0) {
          const k = free[Math.floor(next() * free.length)]!;
          const id = paragraphId(s, ORIGINALS[k]!);
          // Skip the case where the layout merged with an edited neighboring block so that the original paragraph no longer shows separately.
          if (id === undefined) continue;
          const { plan, started } = await begin(s, id);
          const fallback = next() < 0.5;
          const body = `Edit ${++counter}${fallback ? ' 한글' : ' latin'}`;
          await s.updateParagraphDraft(started.draftId, draftInput(plan, body));
          await s.commitParagraphEdit(started.draftId);
          applied.push({ k, fallback });
          undone = []; // the redo steps disappeared as soon as the draft started
          await check(`커밋 ${k}`);
        } else if (pick < 0.5 && free.length > 0) {
          const k = free[Math.floor(next() * free.length)]!;
          const id = paragraphId(s, ORIGINALS[k]!);
          if (id === undefined) continue;
          const { plan, started } = await begin(s, id);
          await s.updateParagraphDraft(started.draftId, draftInput(plan, 'cancelled 한글'));
          await s.cancelParagraphEdit(started.draftId);
          undone = []; // even after cancelling, the redo steps MuPDF discarded do not come back
          await check(`취소 ${k}`);
        } else if (pick < 0.7 && applied.length > 0) {
          undone.push(applied.pop()!);
          await s.undo();
          await check('undo');
        } else if (pick < 0.85 && undone.length > 0) {
          applied.push(undone.pop()!);
          await s.redo();
          await check('redo');
        } else if (pick < 0.95) {
          const saved = s.save({ changes: [] });
          expect(saved.bytes.length).toBeGreaterThan(0);
          // If replacing the fallback subset changes the document inside the operation, the redo steps disappear.
          if (applied.some((a) => a.fallback)) undone = [];
          await check('저장');
        }
      }
      // Even if there were edits that used the fallback, the document has no more than one live fallback font (earlier attempts were rolled back).
      const live = new Set<string>();
      for (let n = 1; n < s.document.countObjects(); n++) {
        const obj = s.document.newIndirect(n);
        if (obj.isDictionary() && !obj.get('PdfEditorFallback').isNull()) live.add(String(n));
      }
      expect(live.size).toBeLessThanOrEqual(1);
      s.close();
    },
  );
});
