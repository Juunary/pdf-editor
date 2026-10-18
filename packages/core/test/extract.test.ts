import { existsSync, readFileSync } from 'node:fs';
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { PdfSession, extractPageDetailed } from '../src/index.js';
import * as mupdf from 'mupdf';
import type { PageModel } from '@pdf-editor/shared-types';
import { buildPdf, hexGlyphs, koreanFont, type PageSpec } from './pdf-fixtures.js';

function open(pages: Array<string | PageSpec>): PdfSession {
  const s = new PdfSession();
  s.open(buildPdf(pages));
  return s;
}

function extract(content: string | PageSpec, includePathSegments = false): PageModel {
  const s = open([content]);
  const model = s.extractPage({ pageIndex: 0, includePathSegments });
  s.close();
  return model;
}

const text = (m: PageModel) => m.chars.map((c) => c.text).join('');
const seqs = (m: PageModel) => m.chars.map((c) => c.glyphSeq);
const show = (tr: number, body: string) => `BT /F1 12 Tf ${tr} Tr 10 150 Td ${body} ET`;

describe('extractPage: 글자·좌표·읽기 순서', () => {
  const model = extract(
    `BT /F1 12 Tf 10 150 Td (Hello) Tj ET BT /F2 14 Tf 10 100 Td ${hexGlyphs('한글')} Tj ET`,
  );

  it('글리프 번호는 0부터 연속이고 글자·gid·폰트·크기를 담는다', () => {
    expect(seqs(model)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(text(model)).toBe('Hello한글');
    expect(model.glyphCount).toBe(7);
    expect(model.paintCount).toBe(0);
    expect(model.fonts.map((f) => f.name)).toEqual(['Helvetica', 'NotoSansKR-Regular']);
    expect(model.chars.map((c) => c.fontId)).toEqual([0, 0, 0, 0, 0, 1, 1]);
    expect(model.chars[0]!.size).toBeCloseTo(12, 5);
    expect(model.chars[5]!.size).toBeCloseTo(14, 5);
    expect(model.chars[5]!.gid).toBeGreaterThan(0);
    expect(model.chars.every((c) => c.render === 'fill' && !c.clip && c.wmode === 0)).toBe(true);
  });

  it('원점은 페이지 공간(좌상단 원점, y 아래)이고 quad 가 기준선을 둘러싼다', () => {
    expect(model.bounds).toEqual([0, 0, 300, 200]);
    expect(model.userToPage).toEqual([1, 0, 0, -1, 0, 200]);
    const h = model.chars[0]!;
    expect(h.origin).toEqual([10, 50]);
    const [ulx, uly, urx, ury, llx, lly, lrx, lry] = h.quad;
    expect(ulx).toBeCloseTo(10, 3);
    expect(llx).toBeCloseTo(10, 3);
    expect(urx).toBeGreaterThan(ulx);
    expect(lrx).toBeCloseTo(urx, 3);
    expect(uly).toBeLessThan(50);
    expect(lly).toBeGreaterThan(50);
    expect(ury).toBeCloseTo(uly, 3);
    expect(lry).toBeCloseTo(lly, 3);
    // 다음 글자의 원점이 앞 글자 오른쪽 변이다.
    expect(model.chars[1]!.origin[0]).toBeCloseTo(urx, 2);
  });

  it('줄·블록은 읽기 순서이고 글자를 한 번씩 가리킨다', () => {
    expect(model.lines.map((l) => l.chars)).toEqual([
      [0, 1, 2, 3, 4],
      [5, 6],
    ]);
    expect(model.blocks.map((b) => b.lines)).toEqual([[0], [1]]);
    expect(model.lines.map((l) => l.block)).toEqual([0, 1]);
    expect(model.chars.map((c) => c.line)).toEqual([0, 0, 0, 0, 0, 1, 1]);
    expect(model.lines[0]!.dir).toEqual([1, 0]);
    expect(model.lines[0]!.wmode).toBe(0);
  });

  it('경고·계측: 근사 없음, extractMs 기록', () => {
    expect(model.warnings).toEqual([]);
    expect(model.extractMs).toBeGreaterThan(0);
  });

  it('/Rotate 90 쪽: 경계·변환·회전 반영, 원점은 변환된 페이지 공간', () => {
    const m = extract({ content: 'BT /F1 12 Tf 10 150 Td (A) Tj ET', rotate: 90 });
    expect(m.bounds).toEqual([0, 0, 200, 300]);
    expect(m.userToPage).toEqual([0, 1, 1, 0, 0, 0]);
    expect(m.rotation).toBe(90);
    expect(m.chars[0]!.origin).toEqual([150, 10]);
    expect(m.chars[0]!.size).toBeCloseTo(12, 5);
    expect(m.lines[0]!.dir[1]).toBeCloseTo(1, 5);
  });

  it('MediaBox 가 원점이 아니어도 페이지 공간은 좌상단 원점', () => {
    const m = extract({
      content: 'BT /F1 12 Tf 110 250 Td (A) Tj ET',
      mediabox: [100, 100, 400, 300],
    });
    expect(m.bounds).toEqual([0, 0, 300, 200]);
    expect(m.chars[0]!.origin).toEqual([10, 50]);
  });
});

describe('extractPage: glyphSeq 규칙(Tr 0–7, 계약 3.1 첫 등장 계수)', () => {
  const cases: Array<[number, string, boolean, string]> = [
    [0, 'fill', false, 'AB'],
    [1, 'stroke', false, 'AB'],
    [2, 'fill-stroke', false, 'AB'],
    [3, 'invisible', false, 'AB'],
    [4, 'fill', true, 'AB'],
    [5, 'stroke', true, 'AB'],
    [6, 'fill-stroke', true, 'AB'],
    [7, 'invisible', true, 'AB'],
  ];
  for (const [tr, render, clip, expected] of cases) {
    it(`Tr ${tr}: 글리프를 정확히 한 번 센다(render ${render}, clip ${clip})`, () => {
      const m = extract(show(tr, '(AB) Tj'));
      expect(text(m)).toBe(expected);
      expect(seqs(m)).toEqual([0, 1]);
      expect(m.glyphCount).toBe(2);
      expect(m.chars.map((c) => [c.render, c.clip])).toEqual([
        [render, clip],
        [render, clip],
      ]);
      expect(m.warnings).toEqual([]);
    });
  }

  it('Tr 3(invisible)은 센다. 색은 null', () => {
    const m = extract(show(3, '(AB) Tj'));
    expect(m.chars.map((c) => c.color)).toEqual([null, null]);
    expect(m.chars.every((c) => c.line === 0)).toBe(true);
  });

  it('Tr 7: 클립 콜백에서 처음 센다(invisible, clip true, 색 null). 구조화 텍스트와 결합된다', () => {
    const s = open([show(7, '(AB) Tj')]);
    const page = s.document.loadPage(0);
    const { model, stats } = extractPageDetailed(page, { pageIndex: 0 });
    page.destroy();
    expect(text(model)).toBe('AB');
    expect(model.chars.map((c) => [c.render, c.clip, c.color, c.line])).toEqual([
      ['invisible', true, null, 0],
      ['invisible', true, null, 0],
    ]);
    expect(stats).toMatchObject({ clipCounted: 2, retransmitted: 0, approximated: 0 });
    expect(model.warnings).toEqual([]);
    s.close();
  });

  it('Tr 4–6: ET 재전송을 소비해 세지 않고 stats 에 남긴다', () => {
    const s = open([show(6, '(AB) Tj')]);
    const page = s.document.loadPage(0);
    const { stats } = extractPageDetailed(page, { pageIndex: 0 });
    page.destroy();
    expect(stats).toMatchObject({ glyphs: 2, retransmitted: 2, clipCounted: 0 });
    s.close();
  });

  it('Tr 6 에서 색이 바뀌어 fill 이 나뉘어도(clip 은 하나로 합쳐 옴) 글리프는 한 번씩', () => {
    const m = extract(show(6, '1 0 0 rg (AB) Tj 0 1 0 rg (CD) Tj'));
    expect(text(m)).toBe('ABCD');
    expect(seqs(m)).toEqual([0, 1, 2, 3]);
    expect(m.chars.every((c) => c.render === 'fill-stroke' && c.clip)).toBe(true);
    // fill 색(첫 두 글자 빨강, 뒤 두 글자 초록)
    expect(m.chars.map((c) => c.color)).toEqual([
      [1, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 1, 0],
    ]);
  });

  it('Tr 4 두 BT: 각 BT 의 clip 이 자기 글리프에만 표시된다', () => {
    const m = extract(
      `BT /F1 12 Tf 4 Tr 10 150 Td (AB) Tj ET BT /F1 12 Tf 0 Tr 10 100 Td (CD) Tj ET BT /F1 12 Tf 4 Tr 10 50 Td (EF) Tj ET`,
    );
    expect(text(m)).toBe('ABCDEF');
    expect(m.chars.map((c) => c.clip)).toEqual([true, true, false, false, true, true]);
  });

  it('Tr 0·7 이 섞이면 Tr 7 글리프만 빠지고 번호는 연속', () => {
    const m = extract(`BT /F1 12 Tf 10 150 Td (AB) Tj 7 Tr (CD) Tj 0 Tr (EF) Tj ET`);
    expect(text(m)).toBe('ABEF');
    expect(seqs(m)).toEqual([0, 1, 2, 3]);
  });

  it('Tr 4 의 구조화 텍스트 중복 줄은 줄·블록에 들어가지 않는다', () => {
    const m = extract(show(4, '(AB) Tj'));
    expect(m.lines).toHaveLength(1);
    expect(m.lines[0]!.chars).toEqual([0, 1]);
    expect(m.blocks).toHaveLength(1);
  });

  it('같은 위치에 겹쳐 그린 글리프(가짜 굵게)는 각각 센다', () => {
    const m = extract(`BT /F1 12 Tf 10 150 Td (AB) Tj ET BT /F1 12 Tf 10 150 Td (AB) Tj ET`);
    expect(text(m)).toBe('ABAB');
    expect(seqs(m)).toEqual([0, 1, 2, 3]);
  });

  it('Form XObject 안 글리프는 Do 위치의 실행 순서로 센다', () => {
    const m = extract({
      content:
        'BT /F1 12 Tf 10 150 Td (A) Tj ET q 1 0 0 1 50 50 cm /Fm1 Do Q BT /F1 12 Tf 10 20 Td (Z) Tj ET',
      resources: (doc, res) => {
        const font = (res.Font as Record<string, unknown>).F1;
        res.XObject = {
          Fm1: doc.addStream('BT /F1 10 Tf 5 5 Td (XY) Tj ET', {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 100, 100],
            Resources: { Font: { F1: font } },
          }),
        };
      },
    });
    expect(text(m)).toBe('AXYZ');
    expect(seqs(m)).toEqual([0, 1, 2, 3]);
    // Form 의 BBox 클립은 paintSeq 를 1 쓴다.
    expect(m.paths.map((p) => [p.paintSeq, p.op])).toEqual([[0, 'clip']]);
    expect(m.chars[1]!.origin).toEqual([55, 145]);
  });
});

describe('extractPage: 구조화 텍스트에 없는 글자(quad 근사)', () => {
  it('페이지 밖 글자는 quad 를 근사하고 line -1, 경고', () => {
    const s = open(['BT /F1 12 Tf 10 150 Td (AB) Tj ET BT /F1 12 Tf 350 150 Td (XY) Tj ET']);
    const page = s.document.loadPage(0);
    const { model, stats } = extractPageDetailed(page, { pageIndex: 0 });
    page.destroy();
    expect(text(model)).toBe('ABXY');
    expect(model.chars.map((c) => c.line)).toEqual([0, 0, -1, -1]);
    expect(stats).toMatchObject({ glyphs: 4, matched: 2, approximated: 2 });
    expect(model.warnings).toEqual([
      '구조화 텍스트에 없는 글자 2개: quad 근사, line -1 (glyphSeq 2, 3)',
    ]);
    const x = model.chars[2]!;
    expect(x.origin).toEqual([350, 50]);
    const [ulx, uly, urx, ury, llx, lly, lrx, lry] = x.quad;
    expect(ulx).toBeCloseTo(350, 3);
    expect(llx).toBeCloseTo(350, 3);
    // advance 만큼 오른쪽, 위·아래로 글자 크기에 비례
    expect(urx).toBeGreaterThan(350);
    expect(lrx).toBeCloseTo(urx, 3);
    expect(uly).toBeLessThan(50);
    expect(lly).toBeGreaterThan(50);
    expect(ury).toBeCloseTo(uly, 3);
    expect(lry).toBeCloseTo(lly, 3);
    expect(uly).toBeCloseTo(50 - 0.95 * 12, 3);
    expect(lly).toBeCloseTo(50 + 0.25 * 12, 3);
    // 근사 글자는 줄에 들어가지 않는다.
    expect(model.lines.flatMap((l) => l.chars)).toEqual([0, 1]);
    s.close();
  });

  it('합성 공백은 짝이 없는 구조화 텍스트 글자로 센다(글자·줄에 넣지 않음)', () => {
    const s = open(['BT /F1 12 Tf 10 150 Td [(A) -300 (B)] TJ ET']);
    const page = s.document.loadPage(0);
    const { model, stats } = extractPageDetailed(page, { pageIndex: 0 });
    page.destroy();
    expect(text(model)).toBe('AB');
    expect(model.lines[0]!.chars).toEqual([0, 1]);
    expect(stats.stextOnlySpaces).toBe(1);
    expect(model.warnings).toEqual([]);
    s.close();
  });
});

/** 타일링 패턴 P1(셀에 사각형과 글자 't') 리소스. */
function patternResources(doc: mupdf.PDFDocument, res: Record<string, unknown>): void {
  const font = (res.Font as Record<string, unknown>).F1;
  res.Pattern = {
    P1: doc.addStream('1 0 0 rg 0 0 5 5 re f BT /F1 4 Tf 0 0 Td (t) Tj ET', {
      Type: 'Pattern',
      PatternType: 1,
      PaintType: 1,
      TilingType: 1,
      BBox: [0, 0, 10, 10],
      XStep: 10,
      YStep: 10,
      Resources: { Font: { F1: font } },
    }),
  };
}

/** 소프트 마스크 GsM(마스크 그룹에 사각형과 글자 'M') 리소스. */
function softMaskResources(doc: mupdf.PDFDocument, res: Record<string, unknown>): void {
  const font = (res.Font as Record<string, unknown>).F1;
  const group = doc.addStream('0.5 g 0 0 100 100 re f BT /F1 10 Tf 5 5 Td (M) Tj ET', {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, 100, 100],
    Group: { S: 'Transparency', CS: 'DeviceGray' },
    Resources: { Font: { F1: font } },
  });
  res.ExtGState = { GsM: { SMask: { Type: 'Mask', S: 'Luminosity', G: group } } };
}

describe('extractPage: 쪽 콘텐츠 밖 콜백 제외(패턴 셀·소프트 마스크)', () => {
  it('타일링 패턴 셀 내용은 세지 않는다(패턴으로 칠한 도형은 클립 1개)', () => {
    const m = extract({
      content: '/Pattern cs /P1 scn 120 120 60 60 re f',
      resources: patternResources,
    });
    expect(m.glyphCount).toBe(0);
    expect(m.paths.map((p) => [p.paintSeq, p.op])).toEqual([[0, 'clip']]);
    expect(m.paintCount).toBe(1);
  });

  it('소프트 마스크 그룹 안의 도형·글자는 세지 않는다', () => {
    const m = extract({
      content: 'q /GsM gs 0 0 1 rg 0 0 100 100 re f Q BT /F1 12 Tf 10 150 Td (after) Tj ET',
      resources: softMaskResources,
    });
    expect(text(m)).toBe('after');
    expect(seqs(m)).toEqual([0, 1, 2, 3, 4]);
    expect(m.paths.map((p) => [p.paintSeq, p.op, p.color?.rgb])).toEqual([[0, 'fill', [0, 0, 1]]]);
    expect(m.paintCount).toBe(1);
  });
});

describe('extractPage: 클립 텍스트 첫 등장 계수(계약 3.1 표기 표)', () => {
  const run = (content: string | PageSpec) => {
    const s = open([content]);
    const page = s.document.loadPage(0);
    const result = extractPageDetailed(page, { pageIndex: 0 });
    page.destroy();
    s.close();
    return result;
  };
  const shadingResources = (_doc: mupdf.PDFDocument, res: Record<string, unknown>) => {
    const shading = {
      ShadingType: 2,
      ColorSpace: 'DeviceRGB',
      Coords: [0, 0, 100, 0],
      Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 },
      Extend: [true, true],
    };
    res.Shading = { Sh1: shading };
    res.Pattern = { P2: { PatternType: 2, Shading: shading } };
  };

  it('타일링 패턴 색 텍스트: 클립 콜백에서 처음 세고 beginTile 이 오면 fill·clip false·색 null', () => {
    const { model, stats } = run({
      content: '/Pattern cs /P1 scn BT /F1 12 Tf 10 150 Td (after) Tj ET',
      resources: patternResources,
    });
    expect(text(model)).toBe('after');
    expect(seqs(model)).toEqual([0, 1, 2, 3, 4]);
    expect(model.chars.every((c) => c.render === 'fill' && !c.clip && c.color === null)).toBe(true);
    expect(model.chars.every((c) => c.line === 0)).toBe(true);
    expect(stats).toMatchObject({ clipCounted: 5, retransmitted: 0, approximated: 0 });
    expect(model.paintCount).toBe(0);
  });

  it('셰이딩 패턴 색 텍스트: fillShade 가 오면 fill·clip false, 셰이드는 paintSeq 0', () => {
    const { model } = run({
      content: '/Pattern cs /P2 scn BT /F1 12 Tf 10 150 Td (grad) Tj ET',
      resources: shadingResources,
    });
    expect(text(model)).toBe('grad');
    expect(model.chars.every((c) => c.render === 'fill' && !c.clip && c.color === null)).toBe(true);
    expect(model.shades.map((x) => x.paintSeq)).toEqual([0]);
  });

  it('Tr 7 로 클립한 뒤 sh: 같은 클립의 popClip 전에 셰이드가 오므로 패턴 색 텍스트로 본다', () => {
    const { model } = run({
      content: 'q BT /F1 24 Tf 7 Tr 10 100 Td (AB) Tj ET /Sh1 sh Q',
      resources: shadingResources,
    });
    expect(text(model)).toBe('AB');
    expect(model.chars.every((c) => c.render === 'fill' && !c.clip)).toBe(true);
    expect(model.shades).toHaveLength(1);
  });

  it('Tr 4 와 Tr 7 이 한 BT 에 섞이면 Tr 7 글리프만 새로 센다(번호는 표시 순서)', () => {
    const { model, stats } = run(show(4, '(AB) Tj 7 Tr (CD) Tj'));
    expect(text(model)).toBe('ABCD');
    expect(seqs(model)).toEqual([0, 1, 2, 3]);
    expect(model.chars.map((c) => [c.render, c.clip])).toEqual([
      ['fill', true],
      ['fill', true],
      ['invisible', true],
      ['invisible', true],
    ]);
    expect(stats).toMatchObject({ retransmitted: 2, clipCounted: 2 });
  });

  // pdf-ops `docs/m1-pdf-ops.md` 3.1 실측 표의 사례(첫 등장 순서로 번호를 받는다).
  it('pdf-ops 표: `7 Tr (A) 4 Tr (B)` → B 가 먼저(표시 시점), A 는 ET 재전송에서 새로 센다', () => {
    const { model } = run(show(7, '(A) Tj 4 Tr (B) Tj'));
    expect(text(model)).toBe('BA');
    expect(seqs(model)).toEqual([0, 1]);
    expect(model.chars.map((c) => [c.render, c.clip])).toEqual([
      ['fill', true], // B: Tr 4, 재전송을 소비
      ['invisible', true], // A: Tr 7, 클립 콜백에서 처음 센다
    ]);
  });

  it('pdf-ops 표: `4 Tr (Ab) 0 Tr (Xy) 7 Tr (Cd) 3 Tr (In)` → 8개, Ab·Xy·In·Cd 순', () => {
    const { model, stats } = run(show(4, '(Ab) Tj 0 Tr (Xy) Tj 7 Tr (Cd) Tj 3 Tr (In) Tj'));
    expect(text(model)).toBe('AbXyInCd');
    expect(seqs(model)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(model.chars.map((c) => [c.render, c.clip])).toEqual([
      ['fill', true],
      ['fill', true], // Ab: Tr 4, ignoreText 재전송을 소비
      ['fill', false],
      ['fill', false], // Xy: Tr 0
      ['invisible', false],
      ['invisible', false], // In: Tr 3, ignoreText 에서 처음 센다
      ['invisible', false],
      ['invisible', false], // Cd: Tr 7 이 ignoreText 형태의 재전송에서 처음 센다(Tr 3 과 구분 못함)
    ]);
    expect(stats).toMatchObject({ retransmitted: 2, clipCounted: 0 });
  });

  it('pdf-ops 표: `7 Tr (A) 0 Tr (B)` → B 만(A 는 Device 에 오지 않는다)', () => {
    const { model } = run(show(7, '(A) Tj 0 Tr (B) Tj'));
    expect(text(model)).toBe('B');
  });

  it('pdf-ops 표: `4 Tr (A) 1 Tr (B)` → A·B 각 1(A 의 클립은 없다)', () => {
    const { model } = run(show(4, '(A) Tj 1 Tr (B) Tj'));
    expect(text(model)).toBe('AB');
    expect(model.chars.map((c) => [c.render, c.clip])).toEqual([
      ['fill', false],
      ['stroke', false],
    ]);
  });

  it('BT 마지막 글리프가 Tr 0 이면 앞의 Tr 7 글리프는 Device 에 오지 않는다', () => {
    const { model } = run(show(0, '(AB) Tj 7 Tr (CD) Tj 0 Tr (EF) Tj'));
    expect(text(model)).toBe('ABEF');
  });

  it('알려진 한계: 같은 위치에 일반 글자를 그린 뒤 다른 BT 의 Tr 7 로 같은 글자를 쓰면 재전송으로 오판', () => {
    const { model, stats } = run(`${show(0, '(AB) Tj')} 0 0 5 5 re f ${show(7, '(AB) Tj')}`);
    expect(text(model)).toBe('AB');
    expect(stats.retransmitted).toBe(2);
    expect(model.chars.every((c) => c.clip)).toBe(true);
  });

  it('다른 위치의 같은 글자는 재전송이 아니다', () => {
    const { model } = run(
      'BT /F1 12 Tf 10 150 Td (AB) Tj ET BT /F1 12 Tf 7 Tr 10 100 Td (AB) Tj ET',
    );
    expect(text(model)).toBe('ABAB');
    expect(seqs(model)).toEqual([0, 1, 2, 3]);
  });
});

const near = (
  actual: readonly number[] | null | undefined,
  expected: readonly number[],
  eps = 0.01,
) => {
  expect(actual).not.toBeNull();
  expect(actual!.length).toBe(expected.length);
  actual!.forEach((v, i) => expect(Math.abs(v - expected[i]!)).toBeLessThanOrEqual(eps));
};

describe('extractPage: 색공간', () => {
  const colorSpaces = (doc: mupdf.PDFDocument, res: Record<string, unknown>) => {
    res.ColorSpace = {
      Sep: [
        'Separation',
        'Spot',
        'DeviceRGB',
        { FunctionType: 2, Domain: [0, 1], C0: [1, 1, 1], C1: [1, 0, 0], N: 1 },
      ],
      Lab: ['Lab', { WhitePoint: [0.9505, 1, 1.089], Range: [-128, 127, -128, 127] }],
      Idx: ['Indexed', 'DeviceRGB', 1, doc.newByteString(new Uint8Array([255, 0, 0, 0, 255, 0]))],
    };
  };
  const model = extract({
    content: [
      '0.2 0.4 0.6 rg 0 0 10 10 re f',
      '0.5 g 20 0 10 10 re f',
      '0.2 0.4 0.6 0.1 k 40 0 10 10 re f',
      '/Sep cs 0.7 sc 60 0 10 10 re f',
      '/Lab cs 50 40 -30 sc 80 0 10 10 re f',
      '/Idx cs 1 sc 100 0 10 10 re f',
      '1 0 0 RG 0 0 1 rg BT /F1 12 Tf 1 Tr 10 150 Td (K) Tj ET',
    ].join('\n'),
    resources: colorSpaces,
  });
  const paint = (i: number) => model.paths[i]!.color!;

  it('DeviceRGB·DeviceGray: 원래 값과 같은 sRGB', () => {
    expect(paint(0)).toEqual({
      space: 'DeviceRGB',
      values: expect.any(Array),
      rgb: expect.any(Array),
    });
    near(paint(0).values, [0.2, 0.4, 0.6]);
    near(paint(0).rgb, [0.2, 0.4, 0.6]);
    expect(paint(1).space).toBe('DeviceGray');
    near(paint(1).values, [0.5]);
    near(paint(1).rgb, [0.5, 0.5, 0.5]);
  });

  it('DeviceCMYK: 원래 CMYK 값과 MuPDF 변환 sRGB(렌더 결과와 같은 값)', () => {
    expect(paint(2).space).toBe('DeviceCMYK');
    near(paint(2).values, [0.2, 0.4, 0.6, 0.1]);
    near(paint(2).rgb, [186 / 255, 143 / 255, 104 / 255], 1 / 255);
  });

  it('Separation·Lab·Indexed: 원래 색공간 값과 sRGB 근사', () => {
    expect(paint(3).space).toBe('Separation(DeviceRGB,Spot)');
    near(paint(3).values, [0.7]);
    near(paint(3).rgb, [1, 76 / 255, 76 / 255], 1 / 255);
    expect(paint(4).space).toBe('Lab');
    near(paint(4).values, [50, 40, -30]);
    near(paint(4).rgb, [165 / 255, 91 / 255, 171 / 255], 2 / 255);
    // Indexed 는 인덱스(정수)를 값으로, sRGB 는 팔레트 항목.
    expect(paint(5).space).toBe('Indexed(1,DeviceRGB)');
    expect(paint(5).values).toEqual([1]);
    near(paint(5).rgb, [0, 1, 0], 1 / 255);
  });

  it('stroke 전용 텍스트(Tr 1)의 색은 선 색', () => {
    expect(model.chars[0]!.render).toBe('stroke');
    near(model.chars[0]!.color, [1, 0, 0], 1 / 255);
  });
});

describe('extractPage: 도형', () => {
  const content = [
    '0 0 1 rg 1 0 0 RG 3 w',
    '10 10 50 20 re B', // 채움+선: 콜백 2개
    '100 100 m 150 100 l 150 150 l h f*', // 짝홀 채움
    '200 20 m 220 20 240 40 260 40 c S', // 곡선 선
    '0 0 20 20 re W n', // 클립
  ].join('\n');

  it('채움+선(B)은 paintSeq 2개(fill → stroke), 번호는 0부터 연속', () => {
    const m = extract(content);
    expect(m.paths.map((p) => [p.paintSeq, p.op, p.evenOdd])).toEqual([
      [0, 'fill', false],
      [1, 'stroke', false],
      [2, 'fill', true],
      [3, 'stroke', false],
      [4, 'clip', false],
    ]);
    expect(m.paintCount).toBe(5);
    expect(m.paths.length + m.images.length + m.shades.length).toBe(m.paintCount);
  });

  it('경계·변환·선 폭·색', () => {
    const m = extract(content);
    const [fill, stroke, evenOdd, curve, clip] = m.paths as [
      PageModel['paths'][number],
      PageModel['paths'][number],
      PageModel['paths'][number],
      PageModel['paths'][number],
      PageModel['paths'][number],
    ];
    expect(fill.ctm).toEqual([1, 0, 0, -1, 0, 200]);
    // 사용자 공간 (10,10)–(60,30) → 페이지 공간 (10,170)–(60,190)
    near(fill.bbox, [10, 170, 60, 190]);
    expect(fill.lineWidth).toBeNull();
    expect(fill.alpha).toBe(1);
    near(fill.color!.rgb, [0, 0, 1]);
    // 선 폭 3 을 포함한 경계
    near(stroke.bbox, [8.5, 168.5, 61.5, 191.5]);
    expect(stroke.lineWidth).toBe(3);
    near(stroke.color!.rgb, [1, 0, 0]);
    near(evenOdd.bbox, [100, 50, 150, 100]);
    // 열린 선의 경계는 MuPDF 가 이음·끝 모양 여유(마이터 한계)까지 넓게 잡는다. 곡선 점
    // (200,180)–(260,160)을 포함하면 된다.
    expect(curve.bbox[0]).toBeLessThanOrEqual(200);
    expect(curve.bbox[2]).toBeGreaterThanOrEqual(260);
    expect(curve.bbox[1]).toBeLessThanOrEqual(160);
    expect(curve.bbox[3]).toBeGreaterThanOrEqual(180);
    expect(clip.color).toBeNull();
    expect(clip.lineWidth).toBeNull();
    near(clip.bbox, [0, 180, 20, 200]);
  });

  it('includePathSegments: 요청할 때만 경로 공간 세그먼트를 담는다', () => {
    const without = extract(content);
    expect(without.paths.every((p) => p.segments === null)).toBe(true);
    const withSegments = extract(content, true);
    expect(withSegments.paths[0]!.segments).toEqual([
      { type: 'M', p: [10, 10] },
      { type: 'L', p: [60, 10] },
      { type: 'L', p: [60, 30] },
      { type: 'L', p: [10, 30] },
      { type: 'Z' },
    ]);
    expect(withSegments.paths[2]!.segments).toEqual([
      { type: 'M', p: [100, 100] },
      { type: 'L', p: [150, 100] },
      { type: 'L', p: [150, 150] },
      { type: 'Z' },
    ]);
    expect(withSegments.paths[3]!.segments).toEqual([
      { type: 'M', p: [200, 20] },
      { type: 'C', p1: [220, 20], p2: [240, 40], p3: [260, 40] },
    ]);
  });

  it('투명도(gs ca·CA)는 alpha 로 담긴다', () => {
    const m = extract({
      content: '/Gs1 gs 1 0 0 rg 0 0 1 RG 0 0 50 50 re B',
      resources: (_doc, res) => {
        res.ExtGState = { Gs1: { CA: 0.5, ca: 0.25 } };
      },
    });
    expect(m.paths.map((p) => p.alpha)).toEqual([0.25, 0.5]);
  });

  it('q/Q 클립: popClip 은 번호를 쓰지 않는다', () => {
    const m = extract('q 0 0 50 50 re W n 10 10 20 20 re f Q 100 100 10 10 re f');
    expect(m.paths.map((p) => [p.paintSeq, p.op])).toEqual([
      [0, 'clip'],
      [1, 'fill'],
      [2, 'fill'],
    ]);
  });
});

describe('extractPage: 이미지·셰이드', () => {
  const withImagesAndShade = (doc: mupdf.PDFDocument, res: Record<string, unknown>) => {
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 4, 3], false);
    pixmap.clear(200);
    res.XObject = { Im1: doc.addImage(new mupdf.Image(pixmap)) };
    res.Shading = {
      Sh1: {
        ShadingType: 2,
        ColorSpace: 'DeviceRGB',
        Coords: [0, 0, 100, 0],
        Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 },
        Extend: [true, true],
      },
    };
    res.ExtGState = { Gs1: { ca: 0.5 } };
  };
  const content = [
    'q 100 0 0 50 20 30 cm /Im1 Do Q',
    'q 10 10 80 80 re W n /Sh1 sh Q',
    'q /Gs1 gs BI /W 2 /H 2 /CS /G /BPC 8 ID abcd EI Q',
    'q 30 0 0 30 150 100 cm BI /W 8 /H 8 /IM true /BPC 1 ID 12345678 EI Q',
  ].join('\n');
  const model = extract({ content, resources: withImagesAndShade });

  it('이미지: 픽셀 크기·페이지 공간 경계·변환, 인라인 이미지와 이미지 마스크 포함', () => {
    expect(model.images.map((i) => [i.paintSeq, i.op, i.width, i.height])).toEqual([
      [0, 'image', 4, 3],
      [3, 'image', 2, 2],
      [4, 'image-mask', 8, 8],
    ]);
    // XObject: 사용자 공간 (20,30)–(120,80) → 페이지 공간 (20,120)–(120,170)
    near(model.images[0]!.bbox, [20, 120, 120, 170]);
    near(model.images[0]!.ctm, [100, 0, 0, 50, 20, 120]);
    expect(model.images[0]!.alpha).toBe(1);
    expect(model.images[1]!.alpha).toBe(0.5);
    near(model.images[2]!.bbox, [150, 70, 180, 100]);
  });

  it('셰이드: 무한 경계는 현재 클립 경계로 접는다', () => {
    expect(model.shades).toHaveLength(1);
    expect(model.shades[0]!.paintSeq).toBe(2);
    near(model.shades[0]!.bbox, [10, 110, 90, 190]);
    expect(model.shades[0]!.alpha).toBe(1);
  });

  it('paintSeq 는 이미지·클립·셰이드 전체에서 0부터 겹침 없이 연속', () => {
    const all = [...model.paths, ...model.images, ...model.shades]
      .map((x) => x.paintSeq)
      .sort((a, b) => a - b);
    expect(all).toEqual([0, 1, 2, 3, 4]);
    expect(model.paintCount).toBe(5);
    expect(model.paths.map((p) => [p.paintSeq, p.op])).toEqual([[1, 'clip']]);
  });
});

describe('extractPage: 셰이딩 패턴으로 칠한 도형', () => {
  it('MuPDF 는 clipPath + fillShade 로 보낸다(번호 2개)', () => {
    const m = extract({
      content: '/Pattern cs /P2 scn 10 10 80 80 re f',
      resources: (doc, res) => {
        res.Pattern = {
          P2: {
            PatternType: 2,
            Shading: {
              ShadingType: 2,
              ColorSpace: 'DeviceRGB',
              Coords: [0, 0, 100, 0],
              Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 },
              Extend: [true, true],
            },
          },
        };
        void doc;
      },
    });
    expect(m.paths.map((p) => [p.paintSeq, p.op])).toEqual([[0, 'clip']]);
    expect(m.shades.map((s) => s.paintSeq)).toEqual([1]);
    expect(m.paintCount).toBe(2);
  });
});

describe('extractPage: 주석 제외·경고·캐시', () => {
  it('주석 텍스트는 추출 모델에 들어오지 않는다', () => {
    const s = new PdfSession();
    const doc = new mupdf.PDFDocument();
    const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
    doc.insertPage(
      -1,
      doc.addPage(
        [0, 0, 300, 200],
        0,
        { Font: { F1: font } },
        'BT /F1 12 Tf 10 150 Td (body) Tj ET',
      ),
    );
    const page = doc.loadPage(0);
    const annot = page.createAnnotation('FreeText');
    annot.setRect([100, 20, 250, 60]);
    annot.setContents('ANNOTATION');
    annot.update();
    expect(page.getAnnotations()).toHaveLength(1);
    page.destroy();
    s.open(doc.saveToBuffer('').asUint8Array().slice());
    const m = s.extractPage({ pageIndex: 0 });
    expect(text(m)).toBe('body');
    s.close();
  });

  it('MuPDF 경고를 warnings 에 담고, 끝나면 로그 콜백을 해제한다', () => {
    const m = extract('/NoSuchCS cs 0.5 sc 0 0 10 10 re f');
    expect(m.warnings.length).toBeGreaterThan(0);
    expect(m.warnings.every((w) => w.startsWith('MuPDF: '))).toBe(true);
    // 정상 문서는 경고가 없다(이전 쪽의 경고가 남지 않는다).
    expect(extract('0 0 10 10 re f').warnings).toEqual([]);
  });

  it('쪽별 캐시: 같은 요청은 같은 객체, includePathSegments 는 별도 항목, 무효화하면 새로 만든다', () => {
    const s = open(['0 0 10 10 re f', 'BT /F1 12 Tf 10 150 Td (p2) Tj ET']);
    const a = s.extractPage({ pageIndex: 0 });
    expect(s.extractPage({ pageIndex: 0 })).toBe(a);
    const withSegments = s.extractPage({ pageIndex: 0, includePathSegments: true });
    expect(withSegments).not.toBe(a);
    expect(withSegments.paths[0]!.segments).not.toBeNull();
    expect(a.paths[0]!.segments).toBeNull();
    const b = s.extractPage({ pageIndex: 1 });
    s.invalidatePageCache(0);
    expect(s.extractPage({ pageIndex: 1 })).toBe(b);
    const a2 = s.extractPage({ pageIndex: 0 });
    expect(a2).not.toBe(a);
    expect(a2.paths).toEqual(a.paths);
    s.invalidatePageCache();
    expect(s.extractPage({ pageIndex: 1 })).not.toBe(b);
    s.close();
  });

  it('캐시는 최근 사용 순으로 16쪽까지 보관한다', () => {
    const s = open(Array.from({ length: 18 }, (_, i) => `BT /F1 12 Tf 10 150 Td (${i}) Tj ET`));
    const first = s.extractPage({ pageIndex: 0 });
    for (let i = 1; i <= 16; i++) s.extractPage({ pageIndex: i });
    // 0 쪽은 17번째로 들어온 항목에 밀려 빠졌다.
    expect(s.extractPage({ pageIndex: 0 })).not.toBe(first);
    s.close();
  });
});

describe('extractPage: 합자', () => {
  const DEJAVU = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  it('glyphText: 합자 코드포인트는 NFKC 전개', async () => {
    const { glyphText } = await import('../src/extract-stext.js');
    expect(glyphText(0xfb01)).toBe('fi');
    expect(glyphText(0xfb03)).toBe('ffi');
    expect(glyphText(0x41)).toBe('A');
    expect(glyphText(0x1f600)).toBe('😀');
    expect(glyphText(0)).toBe('�');
    expect(glyphText(-1)).toBe('�');
    expect(glyphText(0xd800)).toBe('�');
  });

  it('ToUnicode 가 글리프 하나를 여러 글자로 대응시키면 글리프는 한 번만 세고 text 에 모은다', () => {
    // MuPDF 는 이런 글리프를 gid 한 번 + 나머지 글자 gid -1(폭 0) 항목으로 보낸다.
    const gidA = koreanFont.encodeCharacter('A').toString(16).padStart(4, '0');
    const gidB = koreanFont.encodeCharacter('B').toString(16).padStart(4, '0');
    const m = extract({
      content: `BT /F2 14 Tf 10 150 Td ${hexGlyphs('ABA')} Tj ET`,
      resources: (doc, res) => {
        const font = (res.Font as Record<string, mupdf.PDFObject>).F2!;
        font.put(
          'ToUnicode',
          doc.addStream(
            [
              '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
              '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
              '/CMapName /Adobe-Identity-UCS def /CMapType 2 def',
              '1 begincodespacerange <0000> <FFFF> endcodespacerange',
              `2 beginbfchar <${gidA}> <00540068> <${gidB}> <0042> endbfchar`,
              'endcmap CMapName currentdict /CMap defineresource pop end end',
            ].join('\n'),
            {},
          ),
        );
      },
    });
    expect(m.glyphCount).toBe(3);
    expect(m.chars.map((c) => c.text)).toEqual(['Th', 'B', 'Th']);
    expect(seqs(m)).toEqual([0, 1, 2]);
    expect(m.chars.every((c) => c.line === 0)).toBe(true);
    expect(m.lines[0]!.chars).toEqual([0, 1, 2]);
    expect(m.warnings).toEqual([]);
  });

  it.skipIf(!existsSync(DEJAVU))(
    '합자 글리프 하나가 "fi" 한 글자로 들어오고 뒤 글자와 짝이 어긋나지 않는다',
    () => {
      const font = new mupdf.Font('DejaVu', readFileSync(DEJAVU));
      const gid = (c: string | number) => font.encodeCharacter(c).toString(16).padStart(4, '0');
      const m = extract({
        content: `BT /F3 14 Tf 10 150 Td <${gid('A')}${gid(0xfb01)}${gid('B')}> Tj ET`,
        resources: (doc, res) => {
          (res.Font as Record<string, unknown>).F3 = doc.addFont(font);
        },
      });
      expect(m.chars.map((c) => c.text)).toEqual(['A', 'fi', 'B']);
      expect(m.chars.every((c) => c.line === 0)).toBe(true);
      expect(m.lines[0]!.chars).toEqual([0, 1, 2]);
      expect(m.warnings).toEqual([]);
    },
  );
});

describe('extractPage: 래퍼 소유권(mupdf.js Shade 래퍼)', () => {
  it('셰이드가 있는 쪽을 GC 와 함께 반복 추출해도 문서가 손상되지 않는다', async () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const s = open([
      {
        content: 'q 10 10 80 80 re W n /Sh1 sh Q BT /F1 12 Tf 10 150 Td (shade) Tj ET',
        resources: (_doc, res) => {
          res.Shading = {
            Sh1: {
              ShadingType: 2,
              ColorSpace: 'DeviceRGB',
              Coords: [0, 0, 100, 0],
              Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 },
              Extend: [true, true],
            },
          };
        },
      },
    ]);
    for (let i = 0; i < 400; i++) {
      s.invalidatePageCache();
      expect(s.extractPage({ pageIndex: 0 }).shades).toHaveLength(1);
      if (i % 20 === 0) {
        gc();
        // 종료자(FinalizationRegistry)는 GC 뒤 다음 태스크에서 돈다.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    gc();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 해제된 셰이드를 다시 쓰면 "Unexpected mesh type" 으로 실패한다.
    expect(s.renderPage({ pageIndex: 0, scale: 1 }).width).toBe(300);
    s.invalidatePageCache();
    expect(s.extractPage({ pageIndex: 0 }).shades).toHaveLength(1);
    s.close();
  });
});
