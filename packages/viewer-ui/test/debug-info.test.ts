import { describe, expect, it } from 'vitest';
import {
  classifyChar,
  countMatches,
  describeChar,
  findOp,
  linkSummary,
} from '../src/debug-info.js';
import { makeLinkage, makePageModel, makeSourceMap, makeTextOp } from './fixtures.js';

const model = makePageModel(['ABC']);
const ops = [
  makeTextOp(0),
  makeTextOp(1, { limits: ['spans-stream-boundary'] }),
  makeTextOp(2, {
    stream: { objectNumber: 15, contentsIndex: null },
    formPath: [
      {
        resourceName: 'Fm0',
        doOrdinal: 0,
        objectNumber: 15,
        stream: { objectNumber: 8, contentsIndex: 0 },
        nameRange: [10, 13],
        ctm: [1, 0, 0, 1, 0, 0],
      },
    ],
  }),
];
const map = makeSourceMap(model, ops);

describe('디버그 오버레이 정보', () => {
  it('classifyChar: 매칭 / 편집 제한 / 실패', () => {
    const linkage = makeLinkage(model, [0, 1, -1]);
    expect(classifyChar(linkage, map, 0)).toBe('matched');
    expect(classifyChar(linkage, map, 1)).toBe('limited');
    expect(classifyChar(linkage, map, 2)).toBe('unmatched');
  });

  it('연산 번호가 맵에 없으면 실패로 본다', () => {
    const linkage = makeLinkage(model, [0, 77, 0]);
    expect(classifyChar(linkage, map, 1)).toBe('unmatched');
    expect(classifyChar(linkage, map, 99)).toBe('unmatched');
  });

  it('findOp 는 id 가 인덱스와 달라도 찾는다', () => {
    const shifted = { ...map, ops: [ops[2]!, ops[0]!] };
    expect(findOp(shifted, 0)?.id).toBe(0);
    expect(findOp(shifted, 2)?.id).toBe(2);
    expect(findOp(shifted, -1)).toBeNull();
  });

  it('countMatches', () => {
    expect(countMatches(model, makeLinkage(model, [0, 1, -1]), map)).toEqual({
      matched: 1,
      limited: 1,
      unmatched: 1,
    });
  });

  it('describeChar: 매칭 글자는 op·kind·range·limits 를 포함한다', () => {
    const linkage = makeLinkage(model, [0, 1, -1]);
    const lines = describeChar(model, linkage, map, 1);
    expect(lines[0]).toContain('글자 #1 "B"');
    expect(lines).toContain('연산 #1 Tj (text-show)');
    expect(lines.some((l) => l.includes('Contents[0] obj 8') && l.includes('범위 110–120'))).toBe(
      true,
    );
    expect(lines.at(-1)).toBe('제한: spans-stream-boundary');
  });

  it('describeChar: 제한 없음, Form 경로, 글리프 원점 오차', () => {
    const linkage = makeLinkage(model, [2, 2, 2]);
    const op = map.ops[2]!;
    op.text = {
      fontResource: 'F1',
      fontObjectNumber: 4,
      fontSubtype: 'Type0',
      fontSize: 12,
      tm: [1, 0, 0, 1, 0, 0],
      charSpacing: 0,
      wordSpacing: 0,
      horizontalScale: 1,
      leading: 0,
      rise: 0,
      renderMode: 0,
      glyphs: [
        {
          code: 0xac00,
          byteRange: [3, 5],
          origin: [model.chars[0]!.origin[0] + 0.3, model.chars[0]!.origin[1] + 0.4],
          seq: 0,
        },
      ],
    };
    linkage.charGlyph = [0, -1, -1];
    const lines = describeChar(model, linkage, map, 0);
    expect(lines.some((l) => l.startsWith('Form 스트림 obj 15'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Form 경로 Fm0(obj 15)'))).toBe(true);
    expect(
      lines.some((l) => l.includes('0xAC00') && l.includes('바이트 3–5') && l.includes('0.50pt')),
    ).toBe(true);
    expect(lines.at(-1)).toBe('제한: 없음');
  });

  it('describeChar: 매칭 실패 글자는 실패만 적는다', () => {
    const linkage = makeLinkage(model, [0, 1, -1]);
    const lines = describeChar(model, linkage, map, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('원본 연결: 실패 (unmatched)');
    expect(describeChar(model, linkage, map, 50)).toEqual([]);
  });

  it('linkSummary', () => {
    const stats = makeLinkage(model, [0, 0, -1]).stats;
    const text = linkSummary(stats);
    expect(text).toContain('글자 2/3 (66.7%)');
    expect(text).toContain('도형 0/0 (-)');
    expect(text).toContain('최대 원점 오차 0.25pt');
  });
});
