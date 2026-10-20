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

const ctxOf = (doc: mupdf.PDFDocument) =>
  pageContext(doc, 0, { segments: true, fixedGroups: true });

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

  it('추출이 합성 공백을 넣은 넓은 자간(자간 띄어쓰기)은 자간을 싣지 않는다(간격을 두 번 더하지 않음)', () => {
    const content = 'BT /F1 10 Tf 4 Tc 1 0 0 1 72 250 Tm (DEPARTMENT OF THE TREASURY) Tj ET';
    const ctx = ctxOf(makeDoc([{ content }]));
    const p = ctx.layout.paragraphs[0]!;
    expect(p.text).toMatch(/D E P/);
    const before = origins(ctx);
    const { plan, result, after } = sameTextCommit(ctx, p.id);
    expect(plan.runs.some((r) => r.style.charSpacing)).toBe(false);
    expect(result.summary.lines).toHaveLength(1);
    expect(origins(after)).toHaveLength(before.length);
  });

  it('가로 비율 Tz 를 RunStyle.horizontalScale 로 싣고 편집 블록에 Tz 로 써 같은 텍스트 커밋이 글자 위치를 지킨다', () => {
    const content = LINES.map(
      (t, i) => `BT /F1 10 Tf 85 Tz -0.2 Tc 1 0 0 1 72 ${250 - 12 * i} Tm (${t}) Tj ET`,
    ).join(' ');
    const ctx = ctxOf(makeDoc([{ content }]));
    const p = findParagraph(ctx, 'quick brown');
    const before = origins(ctx);
    const { plan, result, after } = sameTextCommit(ctx, p.id);
    expect(plan.runs.every((r) => r.style.horizontalScale === 0.85)).toBe(true);
    expect(plan.runs.every((r) => r.style.charSpacing === -0.17)).toBe(true);
    expect(result.summary.lines).toHaveLength(p.lines.length);
    expect(maxShift(before, origins(after))).toBeLessThanOrEqual(0.05);
    const block = after.editBlocks[0]!;
    const stream = after.doc.newIndirect(block.objectNumber).readStream().asString();
    expect(stream).toContain('85 Tz');
  });

  it('Tm 배율·Tz 를 곱해 페이지 공간 값으로 바꾼다', () => {
    // Tf 5 × Tm 2 = 글자 크기 10pt, Tc 0.1 × 배율 2 × Tz 0.5 = 0.1pt.
    const content = `BT /F1 5 Tf 0.1 Tc 50 Tz 2 0 0 2 72 250 Tm (${LINES[0]}) Tj ET`;
    const ctx = ctxOf(makeDoc([{ content }]));
    const p = findParagraph(ctx, 'quick brown');
    const plan = planParagraphEdit(ctx, new FontManager(ctx.doc, fallbackFor(ctx.doc)), p.id);
    expect(plan.runs[0]!.style.charSpacing).toBeCloseTo(0.1, 6);
  });

  it('Tm 으로 가로만 줄인 글자는 horizontalScale 로, 기울인 글자는 1 로 본다', () => {
    const plan = (tm: string) => {
      const ctx = ctxOf(makeDoc([{ content: `BT /F1 10 Tf ${tm} Tm (${LINES[0]}) Tj ET` }]));
      const p = findParagraph(ctx, 'quick brown');
      return planParagraphEdit(ctx, new FontManager(ctx.doc, fallbackFor(ctx.doc)), p.id);
    };
    expect(plan('0.9 0 0 1 72 250').runs[0]!.style.horizontalScale).toBeCloseTo(0.9, 6);
    expect('horizontalScale' in plan('1 0 0.2 1 72 250').runs[0]!.style).toBe(false);
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

  it('넓히는 쪽에 이웃 내용이 있으면 그 앞에서 멈춘다', () => {
    const tj = (t: string) =>
      `[${t
        .split(' ')
        .map((w) => `(${w} )`)
        .join(' 120 ')}] TJ`;
    const text = LINES.map((t, i) => `BT /F1 10 Tf 1 0 0 1 72 ${250 - 12 * i} Tm ${tj(t)} ET`);
    const base = ctxOf(makeDoc([{ content: text.join(' ') }]));
    const right = findParagraph(base, 'quick brown').bbox[2];
    // 원 줄 오른쪽 2pt 에 세로 막대(이웃 내용).
    const bar = `0 0 1 rg ${right + 2} 200 3 60 re f`;
    const ctx = ctxOf(makeDoc([{ content: `${text.join(' ')} ${bar}` }]));
    const p = findParagraph(ctx, 'quick brown');
    const plan = planParagraphEdit(ctx, new FontManager(ctx.doc, fallbackFor(ctx.doc)), p.id);
    expect(plan.format.area[2]).toBeGreaterThan(p.bbox[2]);
    expect(plan.format.area[2]).toBeLessThanOrEqual(right + 1.5 + 1e-6);
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

describe('셀 정렬 기준(불일치 #7)', () => {
  it('줄 끝 공백까지 가운데 맞춘 셀도 같은 텍스트 커밋에서 글자가 움직이지 않는다', () => {
    const xs = [100, 200, 300, 400];
    const rows = [100, 130, 160, 190];
    const H = 300;
    const rules: string[] = [];
    for (const y of rows) rules.push(`${xs[0]} ${H - y} m ${xs[3]} ${H - y} l S`);
    for (const x of xs) rules.push(`${x} ${H - rows[0]!} m ${x} ${H - rows[3]!} l S`);
    // "Total " 폭(Helvetica 10) = 25.01pt: 줄 끝 공백을 포함해 셀 가운데(150)에 맞춘다.
    const cells: string[] = [];
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        const centered = r === 1 && c === 1;
        const x = centered ? xs[c]! + 50 - 25.01 / 2 : xs[c]! + 5;
        const t = centered ? 'Total ' : `R${r}C${c}`;
        cells.push(`BT /F1 10 Tf ${x} ${H - (rows[r]! + 14)} Td (${t}) Tj ET`);
      }
    const doc = makeDoc([
      { content: `0.5 w ${rules.join(' ')} ${cells.join(' ')}`, mediabox: [0, 0, 500, 300] },
    ]);
    const ctx = ctxOf(doc);
    const table = ctx.layout.tables[0]!;
    const cell = table.cells.find((c) => c.row === 1 && c.col === 1)!;
    const before = origins(ctx);
    const { plan, after } = sameTextCommit(ctx, cell.paragraphs[0]!);
    expect(plan.format.align).toBe('center');
    expect(maxShift(before, origins(after))).toBeLessThanOrEqual(0.05);
  });
});
