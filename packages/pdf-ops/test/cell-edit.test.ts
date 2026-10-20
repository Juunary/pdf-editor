/**
 * M4 표 셀 편집(docs/m4-contract.md 4.1·D1·D5·V4): 셀 대상·시작 형식·영역 상한·판정 목록, 실제 리플로우 커밋 뒤
 * 위치 보존과 레이아웃 복원(fixedGroups 셀 문단).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type * as mupdf from 'mupdf';
import type { PlacedGlyph } from '@pdf-editor/shared-types';
import { layoutParagraph } from '@pdf-editor/reflow';
import {
  FontManager,
  planPageEditability,
  planParagraphEdit,
  prepareParagraphEdit,
  writeEditBlock,
  type ParagraphEditContext,
} from '../src/index.js';
import { cellTarget } from '../src/cell-edit.js';
import { fallbackFor, newEditId } from './helpers/edit-driver.js';
import { loadModules, pageContext } from './helpers/edit-context.js';
import {
  bytesOf,
  expectNoChangeOutside,
  gridTable,
  makeDoc,
  paragraphOf,
} from './helpers/fixtures-m3.js';

beforeAll(async () => {
  await loadModules();
});

const ROWS = [100, 130, 160, 190];
const ctxOf = (doc: mupdf.PDFDocument) =>
  pageContext(doc, 0, { segments: true, fixedGroups: true });
const gridDoc = (text?: Parameters<typeof gridTable>[1]) =>
  makeDoc([{ content: gridTable(ROWS, text), mediabox: [0, 0, 500, 300] }]);

/** (행, 열) 셀의 첫 문단 id. */
function cellParagraph(ctx: ParagraphEditContext, row: number, col: number): number {
  const c = ctx.layout.tables[0]!.cells.find((x) => x.row === row && x.col === col)!;
  return c.paragraphs[0]!;
}

/** 실제 리플로우로 셀(문단) 편집을 커밋한다. text 가 없으면 시작 텍스트 그대로. */
function commit(ctx: ParagraphEditContext, paragraphId: number, text?: string) {
  const fm = new FontManager(ctx.doc, fallbackFor(ctx.doc));
  const plan = planParagraphEdit(ctx, fm, paragraphId);
  expect(plan.editable, JSON.stringify(plan.limits)).toBe(true);
  const prepared = prepareParagraphEdit(ctx, plan, newEditId());
  const runs = text === undefined ? plan.runs : [{ text, style: plan.runs[0]!.style }];
  const all = runs.map((r) => r.text).join('');
  const { segments } = fm.assign(ctx, all, runs);
  const result = layoutParagraph({
    text: all,
    segments,
    format: plan.format,
    areaLimit: plan.areaLimit,
  });
  writeEditBlock(ctx, prepared, runs, plan.format, result, fm);
  return { plan, result };
}

/** 셀 상자 안 보이는 글자의 원점(글자 순). */
function originsIn(ctx: ParagraphEditContext, box: readonly number[]) {
  return ctx.model.chars
    .filter((c) => c.text.trim() !== '')
    .filter(
      (c) =>
        c.origin[0] >= box[0]! &&
        c.origin[0] <= box[2]! &&
        c.origin[1] >= box[1]! &&
        c.origin[1] <= box[3]!,
    )
    .map((c) => ({ t: c.text, x: c.origin[0], y: c.origin[1] }));
}

/** 정렬 전략 표(머리 + 3행, 오른쪽 정렬 숫자 2열, 괘선 없음). */
function alignedDoc(cash = '1,234'): mupdf.PDFDocument {
  const right = (x: number, y: number, s: string) =>
    `BT /F1 10 Tf ${x - s.length * 5.56} ${300 - y} Td (${s}) Tj ET`;
  const rows = [
    ['Item', '2025', '2024'],
    ['Cash and equivalents', cash, '1,100'],
    ['Receivables', '567', '45,600'],
    ['Inventory', '89', '12'],
  ];
  const parts: string[] = [];
  rows.forEach((r, i) => {
    const y = 100 + 14 * i;
    parts.push(`BT /F1 10 Tf 82 ${300 - y} Td (${r[0]}) Tj ET`);
    parts.push(right(400, y, r[1]!), right(480, y, r[2]!));
  });
  return makeDoc([{ content: parts.join(' '), mediabox: [0, 0, 500, 300] }]);
}

describe('셀 대상(4.1·D1)', () => {
  it('셀 문단은 편집 가능(not-flow-paragraph 아님), target.cell·영역·상한', () => {
    const doc = gridDoc();
    const ctx = ctxOf(doc);
    expect(ctx.layout.tables.map((t) => t.strategy)).toEqual(['lines']);
    const fm = new FontManager(doc, fallbackFor(doc));
    const plan = planParagraphEdit(ctx, fm, cellParagraph(ctx, 1, 1));
    expect(plan.editable, JSON.stringify(plan.limits)).toBe(true);
    expect(plan.target.cell).toEqual({ table: 0, row: 1, col: 1 });
    expect(plan.runs.map((r) => r.text).join('')).toBe('R1C1');
    const cell = ctx.layout.tables[0]!.cells.find((c) => c.row === 1 && c.col === 1)!;
    const text = plan.target.bbox;
    // 상한 = 셀 − 여백(변마다 min(간격, 2pt)).
    expect(plan.areaLimit[0]).toBeCloseTo(cell.bbox[0] + 2, 6);
    expect(plan.areaLimit[2]).toBeCloseTo(cell.bbox[2] - 2, 6);
    expect(plan.areaLimit[1]).toBeCloseTo(cell.bbox[1] + Math.min(2, text[1] - cell.bbox[1]), 6);
    expect(plan.areaLimit[3]).toBeCloseTo(cell.bbox[3] - Math.min(2, cell.bbox[3] - text[3]), 6);
    // 시작 영역: 왼쪽 정렬, 왼쪽 변은 원 글자, 오른쪽은 상한, 세로는 글자 상자.
    expect(plan.format.align).toBe('left');
    expect(plan.format.area[0]).toBeCloseTo(text[0], 6);
    expect(plan.format.area[2]).toBeCloseTo(plan.areaLimit[2], 6);
    expect([plan.format.area[1], plan.format.area[3]]).toEqual([text[1], text[3]]);
    expect(plan.format.firstLineIndent).toBe(0);
  });

  it('판정 목록: 셀마다 한 항목(상자 = 셀 상자, cell 설정)', () => {
    const doc = gridDoc();
    const ctx = ctxOf(doc);
    const list = planPageEditability(ctx, new FontManager(doc, fallbackFor(doc))).paragraphs;
    const cells = list.filter((p) => p.cell !== null);
    expect(cells).toHaveLength(9);
    const t = ctx.layout.tables[0]!;
    for (const e of cells) {
      const c = t.cells.find((x) => x.row === e.cell!.row && x.col === e.cell!.col)!;
      expect(e.bbox).toEqual(c.bbox);
      expect(e.editable).toBe(true);
      expect(e.reasons).toEqual([]);
    }
  });

  it('셀 안 문단 여럿은 한 대상: 꽉 찬 줄 + 같은 줄 간격이면 공백, 아니면 \\n', () => {
    const doc = gridDoc((r, c) => (r === 1 && c === 1 ? ['Alpha', 'Beta'] : `R${r}C${c}`));
    const ctx0 = ctxOf(doc);
    // 셀 (1,1) 을 줄마다 문단 하나로 나눈 레이아웃(셀 안 문단 나누기가 불안정한 경우를 흉내 낸다).
    const t = ctx0.layout.tables[0]!;
    const cell = t.cells.find((c) => c.row === 1 && c.col === 1)!;
    const chars = cell.paragraphs.flatMap((id) => ctx0.layout.paragraphs[id]!.chars);
    const line0 = ctx0.model.chars[chars[0]!]!.line;
    const alpha = chars.filter((ci) => ctx0.model.chars[ci]!.line === line0);
    const beta = chars.filter((ci) => ctx0.model.chars[ci]!.line !== line0);
    // 레이아웃이 한 문단(두 줄)으로 묶어도 짧은 줄은 강제 줄바꿈으로 남긴다(줄 단위 판정).
    expect(cell.paragraphs).toHaveLength(1);
    expect(cellTarget(ctx0.model, ctx0.layout, cell.paragraphs[0]!)!.paragraph.text).toBe(
      'Alpha\nBeta',
    );
    const base = ctx0.layout.paragraphs.length;
    const variant = (alphaLineHeight: number | null, cellRight: number) => {
      const pa = {
        ...paragraphOf(ctx0, alpha, base),
        table: 0,
        column: -1,
        lineHeight: alphaLineHeight,
      };
      const pb = { ...paragraphOf(ctx0, beta, base + 1), table: 0, column: -1 };
      const c2 = {
        ...cell,
        paragraphs: [pa.id, pb.id],
        bbox: [cell.bbox[0], cell.bbox[1], cellRight, cell.bbox[3]] as typeof cell.bbox,
      };
      const paragraphs = ctx0.layout.paragraphs.filter((p) => !cell.paragraphs.includes(p.id));
      const layout = {
        ...ctx0.layout,
        paragraphs: [...paragraphs, pa, pb],
        tables: [{ ...t, cells: t.cells.map((c) => (c === cell ? c2 : c)) }],
      };
      return { ctx: { ...ctx0, layout }, pa, pb };
    };
    // 줄이 셀 안쪽 오른쪽에서 멀다 → "\n".
    const v1 = variant(null, cell.bbox[2]);
    const t1 = cellTarget(v1.ctx.model, v1.ctx.layout, v1.pb.id)!;
    expect(t1.paragraph.text).toBe('Alpha\nBeta');
    expect([...t1.members]).toEqual([v1.pa.id, v1.pb.id]);
    expect(t1.lineHeight).toBeCloseTo(12, 6);
    const fm = new FontManager(doc, fallbackFor(doc));
    const p1 = planParagraphEdit(v1.ctx, fm, v1.pa.id);
    const p2 = planParagraphEdit(v1.ctx, fm, v1.pb.id);
    expect(p2.target.glyphSeqs).toEqual(p1.target.glyphSeqs);
    expect(p1.runs.map((r) => r.text).join('')).toBe('Alpha\nBeta');
    expect(p1.format.lineHeight).toBeCloseTo(12, 6);
    expect(p1.charIndexOfOffset[5]).toBe(-1);
    // 첫 줄이 안쪽 오른쪽 1em 안까지 차고 줄 간격이 같다 → 공백.
    const right = ctx0.model.lines[line0]!.bbox[2] + 4;
    const v2 = variant(12, right);
    expect(cellTarget(v2.ctx.model, v2.ctx.layout, v2.pa.id)!.paragraph.text).toBe('Alpha Beta');
    // 줄 간격이 다르면(앞 문단 줄 간격 20) 차 있어도 "\n".
    const v3 = variant(20, right);
    expect(cellTarget(v3.ctx.model, v3.ctx.layout, v3.pa.id)!.paragraph.text).toBe('Alpha\nBeta');
  });

  it('정렬 전략 표: 오른쪽 정렬 숫자 열은 right, 셀 상자는 바깥 열을 넓힌다', () => {
    const doc = alignedDoc();
    const ctx = ctxOf(doc);
    const t = ctx.layout.tables[0];
    expect(t?.strategy).toBe('text');
    const num = t!.cells.find((c) => c.row === 2 && c.col === 2)!;
    const target = cellTarget(ctx.model, ctx.layout, num.paragraphs[0]!)!;
    expect(target.align).toBe('right');
    expect(target.box[2]).toBeGreaterThan(num.bbox[2]);
    const fm = new FontManager(doc, fallbackFor(doc));
    const plan = planParagraphEdit(ctx, fm, num.paragraphs[0]!);
    expect(plan.format.align).toBe('right');
    expect(plan.format.area[2]).toBeCloseTo(plan.target.bbox[2], 6);
  });
});

describe('셀 커밋(실제 리플로우)·V4', () => {
  it('같은 텍스트 커밋: 글리프 원점 이동 ≤ 0.5pt, 셀 밖 렌더 불변(세 엔진)', async () => {
    const doc = gridDoc();
    const before = bytesOf(doc);
    const ctx = ctxOf(doc);
    const cell = ctx.layout.tables[0]!.cells.find((c) => c.row === 1 && c.col === 1)!;
    const orig = originsIn(ctx, cell.bbox);
    const { result } = commit(ctx, cell.paragraphs[0]!);
    expect(result.summary.overflow).toBe(false);
    const after = originsIn(ctxOf(doc), cell.bbox);
    expect(after.map((o) => o.t)).toEqual(orig.map((o) => o.t));
    const shift = Math.max(...after.map((o, i) => Math.hypot(o.x - orig[i]!.x, o.y - orig[i]!.y)));
    expect(shift).toBeLessThanOrEqual(0.5);
    await expectNoChangeOutside(before, bytesOf(doc), 0, [cell.bbox]);
  });

  it('V4 괘선 표: 커밋 뒤 표 감지 유지, 그 셀 문단 = 블록 하나(table 설정), 다시 편집하면 같은 셀', () => {
    const doc = gridDoc();
    const ctx = ctxOf(doc);
    const shape = (c: ParagraphEditContext) =>
      c.layout.tables.map((t) => [t.strategy, t.rows, t.cols, t.cells.length]);
    const before = shape(ctx);
    commit(ctx, cellParagraph(ctx, 1, 1), 'Edited cell text');
    const after = ctxOf(doc);
    expect(after.editBlocks).toHaveLength(1);
    expect(shape(after)).toEqual(before);
    const cell = after.layout.tables[0]!.cells.find((c) => c.row === 1 && c.col === 1)!;
    expect(cell.paragraphs).toHaveLength(1);
    const p = after.layout.paragraphs[cell.paragraphs[0]!]!;
    expect(p.table).toBe(0);
    expect(p.text.replace(/\s+/g, ' ')).toBe('Edited cell text');
    const fm = new FontManager(doc, fallbackFor(doc));
    const again = planParagraphEdit(after, fm, p.id);
    expect(again.editable).toBe(true);
    expect(again.insertion?.mode).toBe('rewrite-block');
    expect(again.target.cell).toEqual({ table: 0, row: 1, col: 1 });
    const list = planPageEditability(after, fm).paragraphs.filter((e) => e.cell !== null);
    expect(list).toHaveLength(9);
  });

  it('V4 정렬 전략 표: 숫자 셀 커밋 뒤 표 감지 유지, 그 셀 문단 = 블록 하나, 오른쪽 끝 유지', () => {
    const doc = alignedDoc();
    const ctx = ctxOf(doc);
    const shape = (c: ParagraphEditContext) =>
      c.layout.tables.map((t) => [t.strategy, t.rows, t.cols]);
    const before = shape(ctx);
    expect(before).toEqual([['text', 4, 3]]);
    const cell = ctx.layout.tables[0]!.cells.find((c) => c.row === 1 && c.col === 1)!;
    const oldRight = ctx.layout.paragraphs[cell.paragraphs[0]!]!.bbox[2];
    commit(ctx, cell.paragraphs[0]!, '12,345');
    const after = ctxOf(doc);
    expect(shape(after)).toEqual(before);
    const c2 = after.layout.tables[0]!.cells.find((c) => c.row === 1 && c.col === 1)!;
    expect(c2.paragraphs).toHaveLength(1);
    const p = after.layout.paragraphs[c2.paragraphs[0]!]!;
    expect(p.table).toBe(0);
    expect(p.text).toBe('12,345');
    expect(Math.abs(p.bbox[2] - oldRight)).toBeLessThanOrEqual(0.5);
  });

  it('R-L4: 시작 상태에 없는 sourceChar 도 판정 시점 해석으로 쓴다(바뀐 스트림을 다시 읽지 않음)', () => {
    const doc = makeDoc(['BT /F1 12 Tf 50 200 Td 1 0 0 rg (Red ) Tj 0 0 1 rg (bluewords) Tj ET']);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    const plan = planParagraphEdit(ctx, fm, ctx.layout.paragraphs[0]!.id);
    const prepared = prepareParagraphEdit(ctx, plan, newEditId());
    // 파란 구간 가운데 글자(run 시작이 아님).
    const mid = ctx.layout.paragraphs[0]!.chars.find((c) => ctx.model.chars[c]!.text === 'w')!;
    expect(plan.runs.some((r) => r.style.sourceChar === mid)).toBe(false);
    const runs = [{ text: 'Xyz', style: { ...plan.runs[0]!.style, sourceChar: mid } }];
    const { segments } = fm.assign(ctx, 'Xyz', runs);
    const result = layoutParagraph({
      text: 'Xyz',
      segments,
      format: plan.format,
      areaLimit: plan.areaLimit,
    });
    writeEditBlock(ctx, prepared, runs, plan.format, result, fm);
    const again = pageContext(doc, 0);
    const colors = again.model.chars.filter((c) => 'Xyz'.includes(c.text)).map((c) => c.color);
    expect(colors).toEqual([
      [0, 0, 1],
      [0, 0, 1],
      [0, 0, 1],
    ]);
  });

  it('긴 글: 자동 확장은 셀 아래 경계(상한)에서 멈추고 초과 표시', () => {
    const doc = gridDoc();
    const ctx = ctxOf(doc);
    const { plan, result } = commit(
      ctx,
      cellParagraph(ctx, 0, 2),
      'A much longer cell text that wraps over many lines inside the narrow cell box',
    );
    expect(result.summary.overflow).toBe(true);
    expect(result.summary.area[3]).toBeLessThanOrEqual(plan.areaLimit[3] + 1e-6);
    const glyphs: PlacedGlyph[] = result.summary.glyphs;
    expect(Math.max(...glyphs.map((g) => g.x + g.advance))).toBeLessThanOrEqual(
      plan.areaLimit[2] + 0.5,
    );
  });
});
