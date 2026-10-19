/**
 * 임의 순서(커밋·취소·undo·redo·저장)로 편집 엔진을 걸어 다니며, 매 단계 MuPDF 저널과 core 로그가 어긋나지 않고
 * 문서 글자가 기대 모델과 같은지 확인한다.
 */
import { describe, expect, it } from 'vitest';
import type { PdfSession } from '../src/index.js';
import { begin, draftInput, harness, journal, text } from './edit-harness.js';

/** 쪽의 원래 문단 시작 글자(레이아웃 읽기 순서). */
const ORIGINALS = ['Title Heading', 'first paragraph', 'Second paragraph'];

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** 원래 문단(아직 편집 전 글자)의 레이아웃 id. 편집한 문단은 새 글자로 바뀌어 찾을 수 없다. */
function paragraphId(s: PdfSession, original: string): number | undefined {
  return s.getPageLayout(0).paragraphs.find((p) => p.text.startsWith(original))?.id;
}

describe('편집 엔진 임의 순서 걷기', () => {
  it.each([1, 2, 3, 4, 5, 6])('시드 %i: 저널·로그·글자가 매 단계 일치한다', async (seed) => {
    const { s, adapter } = harness();
    const next = lcg(seed);
    // 적용된 편집(undo 스택)과 되돌린 편집(redo 스택). fallback: 한글이 들어간 편집(폴백 폰트 사용).
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
        // 편집한 이웃 블록과 레이아웃이 합쳐져 원래 문단이 따로 보이지 않는 경우는 건너뛴다.
        if (id === undefined) continue;
        const { plan, started } = await begin(s, id);
        const fallback = next() < 0.5;
        const body = `Edit ${++counter}${fallback ? ' 한글' : ' latin'}`;
        await s.updateParagraphDraft(started.draftId, draftInput(plan, body));
        await s.commitParagraphEdit(started.draftId);
        applied.push({ k, fallback });
        undone = []; // 초안을 시작한 순간 redo 단계가 사라졌다
        await check(`커밋 ${k}`);
      } else if (pick < 0.5 && free.length > 0) {
        const k = free[Math.floor(next() * free.length)]!;
        const id = paragraphId(s, ORIGINALS[k]!);
        if (id === undefined) continue;
        const { plan, started } = await begin(s, id);
        await s.updateParagraphDraft(started.draftId, draftInput(plan, 'cancelled 한글'));
        await s.cancelParagraphEdit(started.draftId);
        undone = []; // 취소해도 MuPDF 가 버린 redo 단계는 돌아오지 않는다
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
        // 폴백 서브셋 교체가 작업 안에서 문서를 바꾸면 redo 단계가 사라진다.
        if (applied.some((a) => a.fallback)) undone = [];
        await check('저장');
      }
    }
    // 폴백을 쓴 편집이 있었어도 문서에 폴백 폰트가 둘 이상 살아 있지 않다(이전 시도는 되돌려졌다).
    const live = new Set<string>();
    for (let n = 1; n < s.document.countObjects(); n++) {
      const obj = s.document.newIndirect(n);
      if (obj.isDictionary() && !obj.get('PdfEditorFallback').isNull()) live.add(String(n));
    }
    expect(live.size).toBeLessThanOrEqual(1);
    expect(adapter.probe.embeddedBytes.length).toBeGreaterThanOrEqual(0);
    s.close();
  });
});
