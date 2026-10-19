import { describe, expect, it } from 'vitest';
import { layoutParagraph } from '../src/index.js';

describe('M3 계약 연결부', () => {
  it('layoutParagraph 는 구현 전 "M3 미구현" 예외를 낸다', () => {
    expect(() =>
      layoutParagraph({
        text: '',
        segments: [],
        format: {
          area: [0, 0, 100, 100],
          align: 'left',
          firstLineIndent: 0,
          lineHeight: 12,
          firstBaselineOffset: 10,
          overflow: null,
        },
        areaLimit: [0, 0, 100, 100],
      }),
    ).toThrow('M3 미구현');
  });
});
