import { describe, expect, it } from 'vitest';
import { isOverflowClipped, layoutParagraph, type ReflowInput } from '../src/index.js';
import { format, input, lineTexts, pdfFace, seg, stable } from './helpers.js';

// 시험 폰트 크기 10: 라틴 글자 5pt, 공백 2.5pt, 한글·CJK 10pt, 올림 8pt·내림 -2pt.

describe('정렬', () => {
  it('left·right·center', () => {
    const at = (align: 'left' | 'right' | 'center') =>
      layoutParagraph(input('ab', { align })).summary.lines[0];
    expect(at('left')).toMatchObject({ x0: 0, x1: 10 });
    expect(at('right')).toMatchObject({ x0: 90, x1: 100 });
    expect(at('center')).toMatchObject({ x0: 45, x1: 55 });
  });

  it('justify 는 줄 안 공백에 나눠 줄 폭을 채우고, 마지막 줄은 늘리지 않는다', () => {
    const text = 'aa bb cc dd';
    const r = layoutParagraph(input(text, { align: 'justify', area: [0, 0, 40, 1000] }));
    expect(lineTexts(r, text)).toEqual(['aa bb cc ', 'dd']);
    const [l1, l2] = r.summary.lines;
    expect(l1?.x1).toBeCloseTo(40, 9);
    expect(l2).toMatchObject({ x0: 0, x1: 10 });
    // 자연 폭 35, 남는 5pt 를 공백 둘에 2.5pt 씩.
    const c = r.summary.glyphs.find((g) => g.offset === 6);
    expect(c?.x).toBeCloseTo(30, 9);
    const space = r.summary.glyphs.find((g) => g.offset === 2);
    expect(space?.advance).toBeCloseTo(5, 9);
    // 쓰기 좌표도 같은 위치(쓰기가 TJ 조정으로 옮긴다).
    expect(r.lines[0]?.find((g) => g.offset === 6)?.x).toBeCloseTo(30, 9);
    // 줄 끝 공백은 늘리지 않는다.
    expect(r.summary.glyphs.find((g) => g.offset === 8)?.advance).toBeCloseTo(2.5, 9);
  });

  it('공백이 없는 줄(CJK)은 클러스터 사이에 고르게 나눈다', () => {
    const text = '日本語の文章';
    const r = layoutParagraph(input(text, { align: 'justify', area: [0, 0, 35, 1000] }));
    expect(lineTexts(r, text)).toEqual(['日本語', 'の文章']);
    const xs = r.summary.glyphs.slice(0, 3).map((g) => g.x);
    expect(xs[1]).toBeCloseTo(12.5, 9);
    expect(xs[2]).toBeCloseTo(25, 9);
    expect(r.summary.lines[0]?.x1).toBeCloseTo(35, 9);
    expect(r.summary.lines[1]?.x1).toBeCloseTo(30, 9);
  });

  it('공백이 없는 라틴 단어 줄은 글자 사이를 벌리지 않고 왼쪽에 둔다(추출 시 글자 사이 공백 방지)', () => {
    const text = 'aaaaaaaa bb';
    const r = layoutParagraph(input(text, { align: 'justify', area: [0, 0, 45, 1000] }));
    expect(lineTexts(r, text)).toEqual(['aaaaaaaa ', 'bb']);
    const xs = r.summary.glyphs.slice(0, 8).map((g) => g.x);
    expect(xs).toEqual([0, 5, 10, 15, 20, 25, 30, 35]);
    expect(r.summary.lines[0]?.x1).toBeCloseTo(40, 9);
  });

  it('공백 없는 한글 음절 줄은 음절 사이에 나눈다', () => {
    const text = '가나다라마바';
    const r = layoutParagraph(input(text, { align: 'justify', area: [0, 0, 35, 1000] }));
    expect(lineTexts(r, text)).toEqual(['가나다', '라마바']);
    expect(r.summary.lines[0]?.x1).toBeCloseTo(35, 9);
  });

  it('강제 줄바꿈 앞 줄은 늘리지 않는다', () => {
    const r = layoutParagraph(input('aa bb\ncc', { align: 'justify' }));
    expect(r.summary.lines[0]?.x1).toBeCloseTo(22.5, 9);
  });
});

describe('영역·들여쓰기·기준선', () => {
  it('첫 줄 들여쓰기는 첫 줄 폭을 줄인다', () => {
    const text = 'aaaa bbbb cccc';
    const r = layoutParagraph(input(text, { area: [0, 0, 40, 1000], firstLineIndent: 10 }));
    expect(lineTexts(r, text)).toEqual(['aaaa ', 'bbbb ', 'cccc']);
    expect(r.summary.lines.map((l) => l.x0)).toEqual([10, 0, 0]);
  });

  it('음수 들여쓰기(내어쓰기)는 나머지 줄을 줄인다', () => {
    const text = 'aaaa bbbb cccc';
    const r = layoutParagraph(input(text, { area: [0, 0, 40, 1000], firstLineIndent: -10 }));
    expect(r.summary.lines.map((l) => l.x0)).toEqual([0, 10, 10]);
    expect(lineTexts(r, text)).toEqual(['aaaa ', 'bbbb ', 'cccc']);
  });

  it('첫 기준선 = 영역 위 + firstBaselineOffset, 줄 간격 = lineHeight', () => {
    const r = layoutParagraph(input('a\nb\nc', { area: [5, 100, 105, 1000] }));
    expect(r.summary.lines.map((l) => l.baseline)).toEqual([108, 120, 132]);
    expect(r.summary.glyphs[0]).toMatchObject({ x: 5, y: 108 });
    expect(r.summary.lines[0]).toMatchObject({ ascent: 8, descent: -2 });
  });

  it('영역이 상한을 넘으면 상한으로 자른다', () => {
    const r = layoutParagraph(
      input('ab', { area: [-10, -10, 200, 50], align: 'right' }, pdfFace(), [0, 0, 100, 40]),
    );
    expect(r.summary.area).toEqual([0, 0, 100, 40]);
    expect(r.summary.lines[0]?.x1).toBe(100);
  });

  it('contentBox 는 줄 글자 상자의 합집합(줄 끝 공백 제외)', () => {
    const r = layoutParagraph(input('aa \nbbbb', {}));
    expect(r.summary.contentBox).toEqual([0, 0, 20, 22]);
  });
});

describe('줄 높이', () => {
  // 원본 폰트에 공백 글리프가 없으면(TeX 폰트 등) 공백만 폴백으로 간다. 폴백 높이(1160·-288)가 줄 상자를 키우면
  // 같은 텍스트 교체도 원 bbox 를 넘어 자동 확장된다(M3 코퍼스 arxiv-2609.10511 1쪽 #1 등, docs/m3-integration.md 10절).
  const tall = { ...pdfFace('tall'), ascent: 1160, descent: -288 };
  const spaced = (text: string, area: [number, number, number, number]): ReflowInput => {
    const segments = [];
    let start = 0;
    for (let i = 1; i <= text.length; i++) {
      if (i === text.length || (text[i] === ' ') !== (text[start] === ' ')) {
        segments.push(seg(text[start] === ' ' ? tall : pdfFace(), start, i));
        start = i;
      }
    }
    return { text, segments, format: format({ area }), areaLimit: [0, 0, 1000, 1000] };
  };

  it('공백 클러스터의 폰트는 글자가 있는 줄의 올림·내림에 넣지 않는다', () => {
    const r = layoutParagraph(spaced('ab cd', [0, 0, 100, 10]));
    expect(r.summary.lines[0]).toMatchObject({ ascent: 8, descent: -2 });
    expect(r.summary.contentBox).toEqual([0, 0, 22.5, 10]);
    expect(r.summary).toMatchObject({ overflow: false, area: [0, 0, 100, 10] });
  });

  it('공백만 있는 줄은 공백 폰트의 올림·내림을 쓴다', () => {
    const r = layoutParagraph(spaced('ab\n ', [0, 0, 100, 1000]));
    expect(r.summary.lines[1]).toMatchObject({ ascent: 11.6, descent: -2.88 });
  });
});

describe('초과·자동 확장(2026-10-20 사용자 결정)', () => {
  // 한 줄: 기준선 8, 아래 = 10.
  it('마지막 줄 아래가 영역 아래 + 0.5pt 를 넘으면 아래 변을 그만큼 내린다', () => {
    const fits = layoutParagraph(input('a', { area: [0, 0, 100, 9.5] }));
    expect(fits.summary).toMatchObject({ overflow: false, area: [0, 0, 100, 9.5] });
    const grown = layoutParagraph(input('a', { area: [0, 0, 100, 9.4] }));
    expect(grown.summary).toMatchObject({ overflow: false, area: [0, 0, 100, 10] });
    expect(grown.summary).not.toHaveProperty('fontScale');
    // 글자 크기는 그대로(축소 없음).
    expect(grown.summary.glyphs[0]?.size).toBe(10);
  });

  it('필요한 만큼 아래 변을 내리고 상한에서 멈추며, 막히면 초과 유지', () => {
    const text = 'a\nb\nc'; // 아래 = 8 + 24 + 2 = 34
    const ok = layoutParagraph(input(text, { area: [0, 0, 100, 20] }));
    expect(ok.summary).toMatchObject({ overflow: false, area: [0, 0, 100, 34] });
    const blocked = layoutParagraph(
      input(text, { area: [0, 0, 100, 20] }, pdfFace(), [0, 0, 100, 30]),
    );
    expect(blocked.summary).toMatchObject({ overflow: true, area: [0, 0, 100, 30] });
    // 넘친 줄도 그대로 놓는다(자동 클립 없음). 상한 밖으로 나간 부분은 overflow-clipped 판단.
    expect(blocked.lines.flat()).toHaveLength(3);
    expect(blocked.summary.contentBox[3]).toBe(34);
    expect(isOverflowClipped(blocked.summary, [0, 0, 100, 30])).toBe(true);
    expect(isOverflowClipped(ok.summary, [0, 0, 1000, 1000])).toBe(false);
  });

  it('넘치지 않으면 영역을 바꾸지 않는다(사용자가 넓힌 영역은 줄이지 않음)', () => {
    const fits = layoutParagraph(input('a', { area: [0, 0, 100, 50] }));
    expect(fits.summary.area).toEqual([0, 0, 100, 50]);
  });

  it('사용자가 영역을 글 높이보다 줄여도 글 높이까지 다시 늘어난다(줄 폭은 그대로)', () => {
    const text = 'aaaa bbbb cccc';
    const full = layoutParagraph(input(text, { area: [0, 0, 50, 100] }));
    const small = layoutParagraph(input(text, { area: [0, 0, 50, 5] }));
    expect(lineTexts(small, text)).toEqual(lineTexts(full, text));
    expect(small.summary.area[3]).toBe(full.summary.contentBox[3]);
    expect(small.summary.overflow).toBe(false);
  });

  it('이전 빌드의 overflow·fontScale 필드가 형식에 남아 있어도 무시한다(축소 없음)', () => {
    const text = 'a\nb\nc';
    const legacy = {
      area: [0, 0, 100, 20],
      overflow: 'shrink',
      fontScale: 0.85,
    } as unknown as Parameters<typeof input>[1];
    const r = layoutParagraph(input(text, legacy));
    expect(r.summary).toMatchObject({ overflow: false, area: [0, 0, 100, 34] });
    expect(r.summary.glyphs.every((g) => g.size === 10)).toBe(true);
    expect(stable(r)).toEqual(stable(layoutParagraph(input(text, { area: [0, 0, 100, 20] }))));
  });
});

describe('빈 텍스트·glyph-missing', () => {
  it('빈 텍스트도 캐럿용 줄 1개', () => {
    const r = layoutParagraph(input('', {}));
    expect(r.summary.lines).toEqual([
      { baseline: 8, x0: 0, x1: 0, ascent: 8, descent: -2, start: 0, end: 0, hardBreak: false },
    ]);
    expect(r.summary.glyphs).toEqual([]);
    expect(r.lines).toEqual([[]]);
    expect(r.summary.contentBox).toEqual([0, 0, 0, 10]);
  });

  it('빈 텍스트의 캐럿 높이는 길이 0 구간의 폰트·크기를 따른다', () => {
    const r = layoutParagraph({
      text: '',
      segments: [seg(pdfFace(), 0, 0, { size: 20 })],
      format: format({ align: 'right' }),
      areaLimit: [0, 0, 1000, 1000],
    });
    expect(r.summary.lines[0]).toMatchObject({ ascent: 16, descent: -4, x0: 100, x1: 100 });
  });

  it('face 가 null 인 구간은 배치하지 않는다(폭 0, 쓰지 않음)', () => {
    const face = pdfFace();
    const r = layoutParagraph({
      text: 'abXcd',
      segments: [seg(face, 0, 2), seg(null, 2, 3), seg(face, 3, 5)],
      format: format(),
      areaLimit: [0, 0, 1000, 1000],
    });
    const missing = r.summary.glyphs.find((g) => g.offset === 2);
    expect(missing).toMatchObject({ font: { kind: 'missing' }, advance: 0, x: 10 });
    expect(r.summary.glyphs.find((g) => g.offset === 3)?.x).toBe(10);
    expect(r.lines[0]?.map((g) => g.offset)).toEqual([0, 1, 3, 4]);
    expect(r.summary.lines[0]?.x1).toBe(20);
  });

  it('원본 폰트가 쓸 수 없는 클러스터(encode null)도 missing 으로 둔다', () => {
    const face = pdfFace('o', (ch) => (ch === 'X' ? null : 500));
    const r = layoutParagraph(input('aXb', {}, face));
    expect(r.summary.glyphs.map((g) => g.font.kind)).toEqual(['original', 'missing', 'original']);
    expect(r.lines[0]?.map((g) => g.offset)).toEqual([0, 2]);
  });
});

describe('클러스터·쓰기 글리프', () => {
  it('확장 자소 단위로 encode 하고 줄 나눔한다', () => {
    const calls: string[] = [];
    const face = pdfFace('o', () => 500, calls);
    const text = 'e\u0301x👨\u200D👩\u200D👧';
    const r = layoutParagraph(input(text, {}, face));
    expect(calls).toEqual(['e\u0301', 'x', '👨\u200D👩\u200D👧']);
    expect(r.summary.glyphs.map((g) => [g.offset, g.length])).toEqual([
      [0, 2],
      [2, 1],
      [3, 8],
    ]);
    // 클러스터 안 글리프는 같은 offset·length 를 갖고 앞 글리프 폭만큼 이어 놓인다.
    const first = r.lines[0]?.filter((g) => g.offset === 0) ?? [];
    expect(first.map((g) => g.x)).toEqual([0, 5]);
    expect(r.summary.glyphs[0]?.advance).toBe(10);
  });

  it('구간 경계에서 클러스터를 나누고, 쓰기 글리프에 구간 속성을 싣는다', () => {
    const a = pdfFace('a');
    const b = pdfFace('b');
    const r = layoutParagraph({
      text: 'abcd',
      segments: [
        seg(a, 0, 2, { runIndex: 0 }),
        seg(b, 2, 4, { runIndex: 1, size: 20, syntheticBold: true, syntheticItalic: true }),
      ],
      format: format(),
      areaLimit: [0, 0, 1000, 1000],
    });
    const w = r.lines[0] ?? [];
    expect(w.map((g) => [g.faceKey, g.runIndex, g.size, g.x])).toEqual([
      ['a', 0, 10, 0],
      ['a', 0, 10, 5],
      ['b', 1, 20, 10],
      ['b', 1, 20, 20],
    ]);
    expect(w[2]).toMatchObject({
      syntheticBold: true,
      syntheticItalic: true,
      pdfWidth: 500,
      gid: 99,
    });
    expect([...(w[2]?.code ?? [])]).toEqual([99]);
    // 줄 높이는 큰 글자를 따른다.
    expect(r.summary.lines[0]).toMatchObject({ ascent: 16, descent: -4 });
  });

  it('줄 위치는 텍스트를 빈틈 없이 덮는다', () => {
    const text = '가나다 라마바사아자차\n\nabc';
    const r = layoutParagraph(input(text, { area: [0, 0, 45, 1000] }));
    let pos = 0;
    for (const l of r.summary.lines) {
      expect(l.start).toBe(pos);
      pos = l.end;
    }
    expect(pos).toBe(text.length);
  });
});

describe('입력 검사·결정성', () => {
  it('segments 가 텍스트를 덮지 않으면 예외', () => {
    const base: ReflowInput = input('abcd', {});
    expect(() => layoutParagraph({ ...base, segments: [seg(pdfFace(), 0, 2)] })).toThrow('끝');
    expect(() =>
      layoutParagraph({ ...base, segments: [seg(pdfFace(), 0, 2), seg(pdfFace(), 3, 4)] }),
    ).toThrow('빈틈');
    expect(() =>
      layoutParagraph({ ...base, segments: [seg(pdfFace(), 0, 4, { size: 0 })] }),
    ).toThrow('글자 크기');
  });

  it('같은 입력이면 같은 결과', () => {
    const text = '가나다 라마바사아자차 well-known 日本語。です\n끝 (괄호) aaaa';
    for (const area of [
      [0, 0, 60, 30],
      [0, 0, 60, 300],
    ] as const) {
      const make = () => layoutParagraph(input(text, { area: [...area], align: 'justify' }));
      expect(stable(make())).toEqual(stable(make()));
    }
  });
});

describe('자간(FontSegment.charSpacing)', () => {
  it('글리프마다 전진에 더하고 줄 끝 글리프 뒤 자간은 줄 폭에 넣지 않는다', () => {
    const text = 'ab cd';
    const base = input(text);
    const r = layoutParagraph({
      ...base,
      segments: [seg(pdfFace(), 0, text.length, { charSpacing: -0.5 })],
    });
    // 자연 폭 5+5+2.5+5+5 = 22.5, 글리프 5개 × -0.5 중 마지막 뒤 자간 제외 → 22.5 − 2.
    expect(r.summary.lines[0]).toMatchObject({ x0: 0 });
    expect(r.summary.lines[0]?.x1).toBeCloseTo(20.5, 9);
    expect(r.summary.glyphs.map((g) => g.x)).toEqual([0, 4.5, 9, 11, 15.5]);
    expect(r.lines[0]?.map((g) => g.x)).toEqual([0, 4.5, 9, 11, 15.5]);
  });

  it('자간으로 좁아진 줄은 같은 폭에 더 많은 글자가 들어간다', () => {
    const text = 'aaaa aaaa';
    const fmt = { area: [0, 0, 42, 1000] as [number, number, number, number] };
    // 자연 폭 42.5 > 42: 나뉜다.
    expect(lineTexts(layoutParagraph(input(text, fmt)), text)).toEqual(['aaaa ', 'aaaa']);
    // 자간 −0.1 × 8(마지막 글리프 뒤 제외) → 41.7: 한 줄.
    const tight = layoutParagraph({
      ...input(text, fmt),
      segments: [seg(pdfFace(), 0, text.length, { charSpacing: -0.1 })],
    });
    expect(lineTexts(tight, text)).toEqual(['aaaa aaaa']);
  });

  it('가로 비율(horizontalScale)은 글리프 전진에 곱하고 쓰기 글리프에 실린다', () => {
    const text = 'ab';
    const r = layoutParagraph({
      ...input(text),
      segments: [seg(pdfFace(), 0, text.length, { horizontalScale: 0.8 })],
    });
    expect(r.summary.glyphs.map((g) => g.x)).toEqual([0, 4]);
    expect(r.summary.lines[0]?.x1).toBeCloseTo(8, 9);
    expect(r.lines[0]?.map((g) => g.horizontalScale)).toEqual([0.8, 0.8]);
    const plain = layoutParagraph(input(text));
    expect(plain.lines[0]?.every((g) => !('horizontalScale' in g))).toBe(true);
  });
});
