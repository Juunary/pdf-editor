/**
 * 시작 상태 충실도(docs/m3-integration.md 10.4 제안 1·2, docs/m4-pdf-ops.md 6절 #7): 원본 자간 Tc 를 RunStyle.charSpacing
 * 으로 싣고, 원 줄 자연 폭이 영역보다 넓으면(TJ 커닝) 시작 영역을 넓혀 같은 텍스트 편집이 줄을 더 일찍 바꾸지 않는다.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type * as mupdf from 'mupdf';
import { layoutParagraph } from '@pdf-editor/reflow';
import {
  FontManager,
  planParagraphEdit,
  prepareParagraphEdit,
  writeEditBlock,
  type ParagraphEditContext,
} from '../src/index.js';
import { fallbackFor, newEditId } from './helpers/edit-driver.js';
import { findParagraph, loadModules, pageContext } from './helpers/edit-context.js';
import { makeDoc } from './helpers/fixtures-m3.js';

beforeAll(async () => {
  await loadModules();
});

const ctxOf = (doc: mupdf.PDFDocument) => pageContext(doc, 0, { fixedGroups: true });

/** 같은 텍스트로 커밋하고 다시 읽은 쪽 상태와 배치 결과. */
function sameTextCommit(ctx: ParagraphEditContext, paragraphId: number) {
  const fm = new FontManager(ctx.doc, fallbackFor(ctx.doc));
  const plan = planParagraphEdit(ctx, fm, paragraphId);
  expect(plan.editable, JSON.stringify(plan.limits)).toBe(true);
  const prepared = prepareParagraphEdit(ctx, plan, newEditId());
  const text = plan.runs.map((r) => r.text).join('');
  const { segments } = fm.assign(ctx, text, plan.runs);
  const result = layoutParagraph({
    text,
    segments,
    format: plan.format,
    areaLimit: plan.areaLimit,
  });
  writeEditBlock(ctx, prepared, plan.runs, plan.format, result, fm);
  return { plan, result, after: ctxOf(ctx.doc) };
}

/** 보이는 글자의 원점(쪽 순서). */
const origins = (ctx: ParagraphEditContext) =>
  ctx.model.chars.filter((c) => c.text.trim() !== '').map((c) => c.origin);

function maxShift(a: readonly (readonly number[])[], b: readonly (readonly number[])[]): number {
  expect(b).toHaveLength(a.length);
  return Math.max(...a.map((p, i) => Math.hypot(p[0]! - b[i]![0]!, p[1]! - b[i]![1]!)));
}

const LINES = ['The quick brown fox jumps over the lazy', 'dog.'];

describe('자간 Tc(제안 1)', () => {
  it('Tc 를 RunStyle.charSpacing(pt)으로 싣고 같은 텍스트 커밋이 글자 위치를 지킨다', () => {
    const content = LINES.map(
      (t, i) => `BT /F1 10 Tf -0.4 Tc 1 0 0 1 72 ${250 - 12 * i} Tm (${t}) Tj ET`,
    ).join(' ');
    const doc = makeDoc([{ content }]);
    const ctx = ctxOf(doc);
    const p = findParagraph(ctx, 'quick brown');
    const before = origins(ctx);
    const { plan, result, after } = sameTextCommit(ctx, p.id);
    expect(plan.runs.every((r) => r.style.charSpacing === -0.4)).toBe(true);
    expect(result.summary.lines).toHaveLength(p.lines.length);
    expect(plan.format.align).toBe('left');
    expect(maxShift(before, origins(after))).toBeLessThanOrEqual(0.05);
  });

  it('Tm 배율·Tz 를 곱해 페이지 공간 값으로 바꾼다', () => {
    // Tf 5 × Tm 2 = 글자 크기 10pt, Tc 0.1 × 배율 2 × Tz 0.5 = 0.1pt.
    const content = `BT /F1 5 Tf 0.1 Tc 50 Tz 2 0 0 2 72 250 Tm (${LINES[0]}) Tj ET`;
    const ctx = ctxOf(makeDoc([{ content }]));
    const p = findParagraph(ctx, 'quick brown');
    const plan = planParagraphEdit(ctx, new FontManager(ctx.doc, fallbackFor(ctx.doc)), p.id);
    expect(plan.runs[0]!.style.charSpacing).toBeCloseTo(0.1, 6);
  });

  it('Tc 가 0 이면 charSpacing 을 넣지 않는다(이전 로그와 같은 모양)', () => {
    const content = `BT /F1 10 Tf 72 250 Td (${LINES[0]}) Tj ET`;
    const ctx = ctxOf(makeDoc([{ content }]));
    const p = findParagraph(ctx, 'quick brown');
    const plan = planParagraphEdit(ctx, new FontManager(ctx.doc, fallbackFor(ctx.doc)), p.id);
    expect('charSpacing' in plan.runs[0]!.style).toBe(false);
  });

  it('커밋한 블록을 다시 편집해도 자간을 /PdfEditorFormat 에서 되살린다', () => {
    const content = LINES.map(
      (t, i) => `BT /F1 10 Tf -0.4 Tc 1 0 0 1 72 ${250 - 12 * i} Tm (${t}) Tj ET`,
    ).join(' ');
    const ctx = ctxOf(makeDoc([{ content }]));
    const { after } = sameTextCommit(ctx, findParagraph(ctx, 'quick brown').id);
    const p = findParagraph(after, 'quick brown');
    const plan = planParagraphEdit(after, new FontManager(after.doc, fallbackFor(after.doc)), p.id);
    expect(plan.target.editedBlock).not.toBeNull();
    expect(plan.runs.every((r) => r.style.charSpacing === -0.4)).toBe(true);
  });
});

describe('영역 가로 보정(제안 2)', () => {
  it('TJ 로 좁힌 줄은 시작 영역을 자연 폭까지 넓혀 같은 텍스트가 줄을 더 일찍 바꾸지 않는다', () => {
    // 각 줄의 단어 사이를 TJ 로 좁힌다(셰이퍼 폭보다 좁게 놓임).
    const tj = (t: string) =>
      `[${t
        .split(' ')
        .map((w) => `(${w} )`)
        .join(' 120 ')}] TJ`;
    const content = LINES.map(
      (t, i) => `BT /F1 10 Tf 1 0 0 1 72 ${250 - 12 * i} Tm ${tj(t)} ET`,
    ).join(' ');
    const ctx = ctxOf(makeDoc([{ content }]));
    const p = findParagraph(ctx, 'quick brown');
    const fm = new FontManager(ctx.doc, fallbackFor(ctx.doc));
    const plan = planParagraphEdit(ctx, fm, p.id);
    expect(plan.format.area[2] - plan.format.area[0]).toBeGreaterThan(p.bbox[2] - p.bbox[0] + 1);
    expect(plan.format.area[0]).toBe(p.bbox[0]);
    expect(plan.format.area[2]).toBeLessThanOrEqual(plan.areaLimit[2]);
    const { result } = sameTextCommit(ctx, p.id);
    expect(result.summary.lines).toHaveLength(p.lines.length);
  });

  it('원 줄이 영역 안에 들면 영역을 바꾸지 않는다', () => {
    const content = LINES.map((t, i) => `BT /F1 10 Tf 72 ${250 - 12 * i} Td (${t}) Tj ET`).join(
      ' ',
    );
    const ctx = ctxOf(makeDoc([{ content }]));
    const p = findParagraph(ctx, 'quick brown');
    const plan = planParagraphEdit(ctx, new FontManager(ctx.doc, fallbackFor(ctx.doc)), p.id);
    expect(plan.format.area).toEqual(p.bbox);
  });
});
