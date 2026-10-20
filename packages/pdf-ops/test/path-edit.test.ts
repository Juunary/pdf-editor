/**
 * M4 패스 편집(docs/m4-contract.md 3절·4.2·4.3·D2–D4): 인터프리터 선택 필드, 판정, 쓰기, 지문, Form 복제.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import type { PathEdit, Rect } from '@pdf-editor/shared-types';
import {
  buildSourceMap,
  planPathEdit,
  planPathEditability,
  pathEditWarnings,
  preparePathEdit,
  writePathEdit,
  type ParagraphEditContext,
} from '../src/index.js';
import { constructPoints } from '../src/path-edit.js';
import { latin1String } from '../src/edit-common.js';
import { readStreamBytes } from '../src/mupdf-util.js';
import { loadModules, pageContext, reopen } from './helpers/edit-context.js';
import { bytesOf, expectNoChangeOutside, gridTable, makeDoc } from './helpers/fixtures-m3.js';

beforeAll(async () => {
  await loadModules();
});

const NONE: PathEdit = {
  transform: null,
  fill: null,
  stroke: null,
  lineWidth: null,
  points: null,
  delete: false,
};
const edit = (e: Partial<PathEdit>): PathEdit => ({ ...NONE, ...e });

/** 쪽 /Contents 를 이은 텍스트. */
function contentText(doc: mupdf.PDFDocument, pageIndex = 0): string {
  const c = doc.findPage(pageIndex).get('Contents');
  const items = c.isArray() ? Array.from({ length: c.length }, (_, i) => c.get(i)) : [c];
  return items.map((s) => latin1String(readStreamBytes(s))).join('\n');
}

const ctxOf = (doc: mupdf.PDFDocument, pageIndex = 0, segments = false) =>
  pageContext(doc, pageIndex, { segments });

/** 판정 → 준비 → 쓰기 한 번. */
function apply(
  ctx: ParagraphEditContext,
  paintSeqs: number[],
  e: PathEdit,
): { bbox: Rect; changed: number[] } {
  const plan = planPathEdit(ctx, paintSeqs);
  expect(plan.editable, JSON.stringify(plan.limits)).toBe(true);
  const prep = preparePathEdit(ctx, plan, 'e1');
  const r = writePathEdit(ctx, prep, e);
  return { bbox: r.bbox, changed: prep.changedObjects };
}

const near = (a: readonly number[], b: readonly number[], tol = 0.01) =>
  a.every((v, i) => Math.abs(v - b[i]!) <= tol);

describe('인터프리터 선택 필드(계약 3절)', () => {
  it('pathOps·strokeColorOps·lineWidthOps·operandRanges', () => {
    const doc = makeDoc([
      '1 0 0 RG 2 w 10 10 m 100 10 l S 0 0 1 rg 50 50 40 30 re f 0 0 400 300 re W n',
    ]);
    const map = buildSourceMap(doc, 0);
    const byOp = (name: string) => map.ops.find((o) => o.op === name)!;
    const S = byOp('S');
    expect(S.pathOps!.map((id) => map.ops[id]!.op)).toEqual(['m', 'l']);
    expect(S.state!.strokeColorOps!.map((id) => map.ops[id]!.op)).toEqual(['RG']);
    expect(S.state!.lineWidthOps!.map((id) => map.ops[id]!.op)).toEqual(['w']);
    const f = byOp('f');
    expect(f.pathOps!.map((id) => map.ops[id]!.op)).toEqual(['re']);
    expect(f.state!.fillColorOps.map((id) => map.ops[id]!.op)).toEqual(['rg']);
    // 칠하기가 경로를 비운다: W 는 그 뒤 re 만.
    const W = byOp('W');
    expect(W.pathOps!.map((id) => map.ops[id]!.op)).toEqual(['re']);
    const re = byOp('re');
    const bytes = readStreamBytes(doc.findPage(0).get('Contents'));
    expect(re.operandRanges!.map((r) => latin1String(bytes.subarray(r[0], r[1])))).toEqual([
      '50',
      '50',
      '40',
      '30',
    ]);
    // 숫자·이름 피연산자만(CS·cs 이름 포함), 그 밖 종류는 기록하지 않는다.
    expect(byOp('w').operandRanges).toHaveLength(1);
    expect(byOp('S').operandRanges).toBeUndefined();
  });

  it('CS + SCN 은 둘 다 strokeColorOps 에 남는다', () => {
    const doc = makeDoc(['/DeviceRGB CS 0 1 0 SCN 10 10 m 100 10 l S']);
    const map = buildSourceMap(doc, 0);
    const S = map.ops.find((o) => o.op === 'S')!;
    expect(S.state!.strokeColorOps!.map((id) => map.ops[id]!.op)).toEqual(['CS', 'SCN']);
  });
});

describe('패스 판정(4.2)', () => {
  const reasonsOf = (content: string, build?: Parameters<typeof makeDoc>[1]) => {
    const doc = makeDoc([content], build);
    return planPathEditability(ctxOf(doc)).map((p) => p.reasons);
  };

  it('단순 채움·선은 편집 가능, n·클립 전용은 목록에 없음', () => {
    expect(
      reasonsOf('0 0 1 rg 50 50 40 30 re f 1 0 0 RG 10 10 m 100 10 l S 0 0 400 300 re W n'),
    ).toEqual([[], []]);
  });

  it('B 는 PathInfo 2개지만 한 항목', () => {
    const doc = makeDoc(['0 0 1 rg 1 0 0 RG 50 50 40 30 re B']);
    const ctx = ctxOf(doc);
    expect(ctx.model.paths).toHaveLength(2);
    const list = planPathEditability(ctx);
    expect(list).toHaveLength(1);
    expect(list[0]!.editable).toBe(true);
  });

  it('제한 사유', () => {
    expect(reasonsOf('10 10 m 2 w 100 10 l S')).toEqual([['path-interleaved-ops']]);
    expect(reasonsOf('60 60 30 30 re W f')).toEqual([['clip-path']]);
    expect(reasonsOf('BT 10 10 50 50 re f ET')).toEqual([['inside-text-object']]);
    expect(
      reasonsOf('/Pattern cs /P scn 10 10 50 50 re f', (doc) => ({
        Pattern: {
          P: doc.addObject({
            Type: 'Pattern',
            PatternType: 2,
            Shading: {
              ShadingType: 2,
              ColorSpace: 'DeviceRGB',
              Coords: [0, 0, 100, 0],
              Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 },
            },
          }),
        },
      })),
    ).toEqual([['pattern-or-shading']]);
    expect(
      reasonsOf('q /S1 gs 10 10 50 50 re f Q 100 10 50 50 re f', (doc) => {
        const g = doc.addStream('0.5 g 0 0 300 300 re f', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 400, 300],
          Group: { S: 'Transparency', CS: 'DeviceGray' },
        });
        return { ExtGState: { S1: { SMask: { Type: 'Mask', S: 'Luminosity', G: g } } } };
      }),
    ).toEqual([['soft-mask'], []]);
  });

  it('구성 ~ 칠하기가 /Contents 스트림 경계에 걸침', () => {
    const doc = makeDoc(['0 g']);
    const page = doc.findPage(0);
    const arr = doc.newArray();
    arr.push(doc.addStream('10 10 m 100 10 l', {}));
    arr.push(doc.addStream('S 20 20 30 30 re f', {}));
    page.put('Contents', arr);
    const list = planPathEditability(ctxOf(reopen(doc)));
    expect(list.map((p) => p.reasons)).toEqual([['path-spans-streams'], []]);
  });

  it('planPathEdit: 색·선 두께(페이지 공간 pt)·지문', () => {
    const doc = makeDoc(['q 2 0 0 2 0 0 cm 0 0 1 rg 1 0 0 RG 3 w 10 10 40 30 re B Q']);
    const ctx = ctxOf(doc);
    const [item] = planPathEditability(ctx);
    const plan = planPathEdit(ctx, [item!.paintSeq]);
    expect(plan.editable).toBe(true);
    expect(plan.fill!.rgb).toEqual([0, 0, 1]);
    expect(plan.stroke!.rgb).toEqual([1, 0, 0]);
    expect(plan.lineWidth).toBeCloseTo(6, 6);
    expect(plan.target.fingerprints).toHaveLength(1);
    expect(plan.target.fingerprints[0]!.paintOp).toBe('B');
    expect(plan.target.fingerprints[0]!.constructOpCount).toBe(1);
    expect(plan.target.paintSeqs).toEqual([item!.paintSeq]);
  });

  it('선택적 콘텐츠는 경고만', () => {
    const doc = makeDoc(['/OC /L1 BDC 10 10 50 50 re f EMC'], (d) => {
      const ocg = d.addObject({ Type: 'OCG', Name: 'L' });
      d.getTrailer()
        .get('Root')
        .put('OCProperties', d.addObject({ OCGs: [ocg], D: { ON: [ocg] } }));
      return { Properties: { L1: ocg } };
    });
    const ctx = ctxOf(doc);
    const [item] = planPathEditability(ctx);
    expect(item!.editable).toBe(true);
    const plan = planPathEdit(ctx, [item!.paintSeq]);
    expect(plan.warnings.map((w) => w.kind)).toContain('optional-content');
  });
});

describe('패스 쓰기(4.3·D3·D4)', () => {
  it('이동: re 피연산자만 다시 쓰고 나머지 바이트는 그대로', () => {
    const doc = makeDoc(['0 0 1 rg 50 50 40 30 re f 1 0 0 RG 10 10 m 100 10 l S']);
    const before = contentText(doc);
    const ctx = ctxOf(doc);
    const [rect] = planPathEditability(ctx);
    const r = apply(ctx, [rect!.paintSeq], edit({ transform: [1, 0, 0, 1, 10, 0] }));
    const after = contentText(doc);
    expect(after).toBe(before.replace('50 50 40 30 re', '60 50 40 30 re'));
    const moved = ctxOf(reopen(doc)).model.paths[0]!.bbox;
    expect(
      near(moved, [rect!.bbox[0] + 10, rect!.bbox[1], rect!.bbox[2] + 10, rect!.bbox[3]]),
    ).toBe(true);
    expect(near(r.bbox, moved)).toBe(true);
  });

  it('크기: 비균일 확대는 re 유지, 선 두께는 그대로', () => {
    const doc = makeDoc(['1 0 0 RG 4 w 50 50 40 30 re S']);
    const ctx = ctxOf(doc);
    const [p] = planPathEditability(ctx);
    // 페이지 공간 (x0,y0) 기준 2배·1배.
    const [x0, y0] = [p!.bbox[0] + 2, p!.bbox[1] + 2];
    apply(ctx, [p!.paintSeq], edit({ transform: [2, 0, 0, 1, -x0, 0] }));
    void y0;
    expect(contentText(doc)).toMatch(/50 50 80 30 re/);
    expect(contentText(doc)).toMatch(/4 w/);
  });

  it('색(D3): DeviceRGB·Gray·CMYK, 같은 색은 쓰지 않음, Gray 에 채도면 RGB + 경고', () => {
    const doc = makeDoc([
      '0 0 1 rg 10 10 20 20 re f 0.5 g 40 10 20 20 re f 0 0 0 1 k 70 10 20 20 re f 0.5 g 100 10 20 20 re f',
    ]);
    const ctx = ctxOf(doc);
    const list = planPathEditability(ctx);
    const seqs = list.map((p) => p.paintSeq);
    const plan = planPathEdit(ctx, seqs.slice(0, 3));
    const prep = preparePathEdit(ctx, plan, 'c');
    writePathEdit(ctx, prep, edit({ fill: [1, 1, 1] }));
    const t = contentText(doc);
    expect(t).toContain('q 1 1 1 rg 10 10 20 20 re f Q');
    expect(t).toContain('q 1 g 40 10 20 20 re f Q');
    expect(t).toContain('q 0 0 0 0 k 70 10 20 20 re f Q');
    expect(pathEditWarnings(ctx, prep)).toEqual([]);
    // 같은 초안 다시 쓰기: 원본 기준이라 앞 쓰기가 남지 않는다.
    writePathEdit(ctx, prep, edit({ fill: [1, 0, 0] }));
    const t2 = contentText(doc);
    expect(t2).toContain('q 1 0 0 rg 10 10 20 20 re f Q');
    expect(t2).toContain('q 1 0 0 rg 40 10 20 20 re f Q');
    expect(t2).not.toContain('1 1 1 rg');
    expect(pathEditWarnings(ctx, prep).map((w) => w.kind)).toEqual(['color-space-changed']);
    // 원래 색과 8비트로 같으면 쓰지 않는다.
    writePathEdit(ctx, prep, edit({ fill: [0, 0, 1] }));
    expect(contentText(doc)).toMatch(/^0 0 1 rg 10 10 20 20 re f 0\.5 g q 0 0 1 rg 40/);
  });

  it('선 두께: 페이지 pt → 콘텐츠 공간(√|det|), 채움 전용 패스에는 쓰지 않음', () => {
    const doc = makeDoc(['q 2 0 0 2 0 0 cm 1 0 0 RG 1 w 10 10 m 50 10 l S 10 20 20 20 re f Q']);
    const ctx = ctxOf(doc);
    const seqs = planPathEditability(ctx).map((p) => p.paintSeq);
    apply(ctx, seqs, edit({ lineWidth: 4 }));
    const t = contentText(doc);
    expect(t).toContain('q 2 w 10 10 m 50 10 l S Q');
    expect(t).toContain('Q 10 20 20 20 re f Q');
    expect(t).not.toContain('q 2 w 10 20');
  });

  it('삭제: 구성 ~ 칠하기를 n 으로, 다른 패스는 그대로', async () => {
    const doc = makeDoc([
      '0 0 1 rg 50 50 40 30 re f 1 0 0 RG 10 10 m 100 10 l S 200 200 20 20 re f',
    ]);
    const before = bytesOf(doc);
    const ctx = ctxOf(doc);
    const list = planPathEditability(ctx);
    const r = apply(ctx, [list[1]!.paintSeq], edit({ delete: true }));
    expect(contentText(doc)).toContain('50 50 40 30 re f 1 0 0 RG n 200 200 20 20 re f');
    const again = ctxOf(reopen(doc));
    expect(again.model.paths).toHaveLength(2);
    await expectNoChangeOutside(before, bytesOf(doc), 0, [r.bbox]);
  });

  it('다중 선택: 같은 이동을 모든 대상에', () => {
    const doc = makeDoc(['10 10 20 20 re f 50 10 20 20 re f 90 10 20 20 re f']);
    const ctx = ctxOf(doc);
    const list = planPathEditability(ctx);
    apply(ctx, [list[0]!.paintSeq, list[2]!.paintSeq], edit({ transform: [1, 0, 0, 1, 0, -5] }));
    // 페이지 공간 위로 5 = 사용자 공간 y + 5.
    expect(contentText(doc)).toBe('10 15 20 20 re f 50 10 20 20 re f 90 15 20 20 re f');
  });

  it('점 편집: re 의 점 하나 → m l l l h, 모델 세그먼트와 대응', () => {
    const doc = makeDoc(['50 50 40 30 re f']);
    const ctx = ctxOf(doc, 0, true);
    const info = ctx.model.paths[0]!;
    expect(info.segments!.map((s) => s.type)).toEqual(['M', 'L', 'L', 'L', 'Z']);
    const [p] = planPathEditability(ctx);
    // 점 2 = (x+w, y+h) 사용자 공간 (90, 80) → 페이지 (90, 300-80).
    apply(ctx, [p!.paintSeq], edit({ points: [{ index: 2, to: [100, 200] }] }));
    expect(contentText(doc)).toBe('50 50 m 90 50 l 100 100 l 50 80 l h f');
  });

  it('점 편집: v 의 첫 점(현재점)을 옮기면 c, y 는 둘째 점이 셋째와 다르면 c', () => {
    const doc = makeDoc(['10 10 m 20 30 40 10 v 60 30 80 10 y S']);
    const ctx = ctxOf(doc, 0, true);
    const info = ctx.model.paths[0]!;
    const segs = info.segments!;
    const mine = constructPoints([
      { op: 'm', nums: [10, 10] },
      { op: 'v', nums: [20, 30, 40, 10] },
      { op: 'y', nums: [60, 30, 80, 10] },
    ]);
    expect(segs).toEqual(mine.segments);
    const [p] = planPathEditability(ctx);
    // 점 1 = v 의 첫 제어점(현재점 10,10), 점 5 = y 의 둘째 점(= 끝점 80,10).
    apply(
      ctx,
      [p!.paintSeq],
      edit({
        points: [
          { index: 1, to: [12, 300 - 12] },
          { index: 5, to: [70, 300 - 20] },
        ],
      }),
    );
    expect(contentText(doc)).toBe('10 10 m 12 12 20 30 40 10 c 60 30 70 20 80 10 c S');
  });

  it('점 편집은 대상 하나만', () => {
    const doc = makeDoc(['10 10 20 20 re f 50 10 20 20 re f']);
    const ctx = ctxOf(doc);
    const seqs = planPathEditability(ctx).map((p) => p.paintSeq);
    const plan = planPathEdit(ctx, seqs);
    const prep = preparePathEdit(ctx, plan, 'p');
    expect(() => writePathEdit(ctx, prep, edit({ points: [{ index: 0, to: [0, 0] }] }))).toThrow(
      /하나만/,
    );
  });

  it('회전 변환은 거절(이동·확대축소만)', () => {
    const doc = makeDoc(['10 10 20 20 re f']);
    const ctx = ctxOf(doc);
    const [p] = planPathEditability(ctx);
    const plan = planPathEdit(ctx, [p!.paintSeq]);
    const prep = preparePathEdit(ctx, plan, 'r');
    expect(() => writePathEdit(ctx, prep, edit({ transform: [0, 1, -1, 0, 0, 0] }))).toThrow();
  });

  it('지문 불일치면 준비 실패(다른 패스를 고치지 않음)', () => {
    const doc = makeDoc(['10 10 20 20 re f 50 10 20 20 re f']);
    const ctx = ctxOf(doc);
    const list = planPathEditability(ctx);
    const plan = planPathEdit(ctx, [list[0]!.paintSeq]);
    // 앞 패스를 지운 문서에서 같은 paintSeq 는 다른 패스를 가리킨다.
    const doc2 = makeDoc(['50 10 20 20 re f']);
    const ctx2 = ctxOf(doc2);
    expect(() => preparePathEdit(ctx2, plan, 'x')).toThrow(/지문/);
  });

  it('path-clipped: 직사각형 클립 밖으로 옮기면 경고', () => {
    const doc = makeDoc(['q 0 0 100 100 re W n 10 10 20 20 re f Q']);
    const ctx = ctxOf(doc);
    const [p] = planPathEditability(ctx);
    const plan = planPathEdit(ctx, [p!.paintSeq]);
    const prep = preparePathEdit(ctx, plan, 'k');
    writePathEdit(ctx, prep, edit({ transform: [1, 0, 0, 1, 200, 0] }));
    expect(pathEditWarnings(ctx, prep).map((w) => w.kind)).toEqual(['path-clipped']);
  });

  it('Form 안: 이 사용 위치만 바꾸고 같은 Form 의 두 패스는 복제본 하나', async () => {
    const doc = makeDoc(['q /X0 Do Q q 1 0 0 1 150 0 cm /X0 Do Q'], (d) => ({
      XObject: {
        X0: d.addStream('0 0 1 rg 10 10 20 20 re f 1 0 0 rg 40 10 20 20 re f', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 100, 100],
          Resources: {},
        }),
      },
    }));
    const before = bytesOf(doc);
    const ctx = ctxOf(doc);
    const list = planPathEditability(ctx);
    expect(list).toHaveLength(4);
    const plan = planPathEdit(ctx, [list[0]!.paintSeq, list[1]!.paintSeq]);
    expect(plan.warnings.map((w) => w.kind)).toContain('shared-form');
    const prep = preparePathEdit(ctx, plan, 'f');
    const r = writePathEdit(ctx, prep, edit({ fill: [0, 1, 0] }));
    // 쪽 + 쪽 콘텐츠 + 복제본 1개.
    const t = contentText(doc);
    expect(t).toMatch(/^q \/PEF0 Do Q q 1 0 0 1 150 0 cm \/X0 Do Q$/);
    const again = ctxOf(reopen(doc));
    const greens = again.model.paths.filter((p) => p.color?.rgb?.join() === '0,1,0');
    expect(greens).toHaveLength(2);
    expect(again.model.paths.filter((p) => p.color?.rgb?.join() === '0,0,1')).toHaveLength(1);
    await expectNoChangeOutside(before, bytesOf(doc), 0, [r.bbox]);
  });

  it('공유 /Contents 스트림은 사본', () => {
    const src = new mupdf.PDFDocument();
    const shared = src.addStream('10 10 20 20 re f', {});
    for (let i = 0; i < 2; i++) {
      src.insertPage(-1, src.addPage([0, 0, 400, 300], 0, {}, ''));
      src.findPage(i).put('Contents', shared);
    }
    const doc = reopen(src);
    const ctx = ctxOf(doc, 0);
    const [p] = planPathEditability(ctx);
    apply(ctx, [p!.paintSeq], edit({ transform: [1, 0, 0, 1, 5, 0] }));
    expect(contentText(doc, 0)).toBe('15 10 20 20 re f');
    expect(contentText(doc, 1)).toBe('10 10 20 20 re f');
  });

  it('표 괘선 삭제 경고(table-rule-removed)', () => {
    const doc = makeDoc([{ content: gridTable(), mediabox: [0, 0, 500, 300] }]);
    const ctx = ctxOf(doc, 0, true);
    expect(ctx.layout.tables.map((t) => t.strategy)).toEqual(['lines']);
    const [p] = planPathEditability(ctx);
    const plan = planPathEdit(ctx, [p!.paintSeq]);
    const prep = preparePathEdit(ctx, plan, 't');
    writePathEdit(ctx, prep, edit({ delete: true }));
    expect(pathEditWarnings(ctx, prep).map((w) => w.kind)).toEqual(['table-rule-removed']);
  });

  it('표 상자와 겹쳐도 LayoutTable.paths 에 없는 패스는 table-rule-removed 를 내지 않는다', () => {
    // 표 오른쪽 위 모서리를 걸치는 짧은 사선(괘선·배경 사각형이 아님). 이전 규칙(표 상자와 1pt 안 겹침)이면 경고했다.
    const content = `${gridTable()} 395 205 m 410 190 l S`;
    const doc = makeDoc([{ content, mediabox: [0, 0, 500, 300] }]);
    const ctx = ctxOf(doc, 0, true);
    const [table] = ctx.layout.tables;
    expect(table!.strategy).toBe('lines');
    expect(table!.paths).toHaveLength(8);
    const paths = planPathEditability(ctx);
    const diagonal = paths.at(-1)!;
    expect(table!.paths).not.toContain(diagonal.pathIndex);
    const plan = planPathEdit(ctx, [diagonal.paintSeq]);
    const prep = preparePathEdit(ctx, plan, 'd');
    writePathEdit(ctx, prep, edit({ delete: true }));
    expect(pathEditWarnings(ctx, prep)).toEqual([]);
  });
});

describe('V2·V3 합성(세 엔진)', () => {
  const content = [
    '0.2 0.4 0.6 rg 1 0 0 RG 1.5 w',
    '10.123456789012 20.987654321098 m 120.5 40.25 l 60.333333333333 90.666666666667 30.1 70.2 15 50 c h B',
    '200 20 m 230 80 260 20 v 290 80 320 20 y S',
    'q 0.8 0 0 0.8 20 140 cm 0 0 0 rg 0 0 80.123456789 40.987654321 re f Q',
    '0.5 g 150 150 m 220 150 l 220 220 l h f*',
  ].join(' ');

  it('V2: 칠하기마다 q … Q 로 감싸도 렌더가 같다', async () => {
    const doc = makeDoc([content]);
    const before = bytesOf(doc);
    const ctx = ctxOf(doc);
    const ops = ctx.map.ops;
    const bytes = readStreamBytes(doc.findPage(0).get('Contents'));
    const reps: { start: number; end: number; text: string }[] = [];
    for (const p of planPathEditability(ctx)) {
      const paint = ops[ctx.linkage.pathOp[p.pathIndex]!]!;
      const first = ops[paint.pathOps![0]!]!;
      reps.push({ start: first.range[0], end: first.range[0], text: 'q ' });
      reps.push({ start: paint.range[1], end: paint.range[1], text: ' Q' });
    }
    expect(reps).toHaveLength(8);
    const { applyReplacements } = await import('../src/text-remove.js');
    doc.findPage(0).get('Contents').writeStream(applyReplacements(bytes, reps));
    await expectNoChangeOutside(before, bytesOf(doc), 0, []);
  });

  it('V3: 구성 연산 피연산자를 9자리로 다시 써도 렌더가 같다', async () => {
    const doc = makeDoc([content]);
    const before = bytesOf(doc);
    const ctx = ctxOf(doc);
    // 같은 좌표는 바뀐 연산이 없어 쓰지 않으므로 1e-12pt 이동(다중 선택)으로 모든 구성 연산을 다시 쓴다.
    const seqs = planPathEditability(ctx).map((p) => p.paintSeq);
    const plan = planPathEdit(ctx, seqs);
    writePathEdit(
      ctx,
      preparePathEdit(ctx, plan, 'v3'),
      edit({ transform: [1, 0, 0, 1, 1e-12, 0] }),
    );
    expect(contentText(doc)).toContain('80.1234568 40.9876543 re');
    expect(contentText(doc)).toContain('230 80 260 20 v 290 80 320 20 y');
    expect(contentText(doc)).toMatch(
      /^0\.2 0\.4 0\.6 rg 1 0 0 RG 1\.5 w 10\.1234568 20\.9876543 m/,
    );
    await expectNoChangeOutside(before, bytesOf(doc), 0, []);
  });
});
