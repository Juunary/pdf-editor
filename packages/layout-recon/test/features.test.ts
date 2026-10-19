import { describe, expect, it } from 'vitest';
import { fingerprintText, lineFeatures } from '../src/features.js';
import { summarizePaths } from '../src/paths.js';
import { buildModel, gridPaths, lineSegments, rectSegments } from './helpers/model-builder.js';

describe('lineFeatures', () => {
  it('줄 텍스트·크기·굵기·단어 상자', () => {
    const model = buildModel({
      lines: [
        { x: 72, y: 100, text: 'Hello world', size: 10 },
        { x: 72, y: 120, text: 'Bold', size: 12, bold: true },
      ],
    });
    const [a, b] = lineFeatures(model);
    expect(a!.text).toBe('Hello world');
    expect(a!.size).toBe(10);
    expect(a!.words.map((w) => w.text)).toEqual(['Hello', 'world']);
    expect(a!.segments).toHaveLength(1);
    expect(a!.horizontal).toBe(true);
    expect(b!.bold).toBe(true);
    expect(b!.baseline).toBe(120);
    expect(fingerprintText(model)).toBe('Hello world\nBold');
  });

  it('spaceAfter 합성 공백을 텍스트·단어 경계에 반영', () => {
    const model = buildModel({ lines: [{ x: 0, y: 50, text: 'ab' }] });
    model.lines[0]!.spaceAfter = [0];
    const [f] = lineFeatures(model);
    expect(f!.text).toBe('a b');
    expect(f!.words.map((w) => w.text)).toEqual(['a', 'b']);
  });
});

describe('summarizePaths', () => {
  it('선분·사각형 테두리·얇은 채움을 괘선으로, 큰 채움을 배경 상자로', () => {
    const model = buildModel({
      paths: [
        ...gridPaths([50, 150, 250], [100, 120]),
        { op: 'fill', segments: rectSegments([50, 200, 250, 201]) },
        { op: 'fill', segments: rectSegments([50, 300, 250, 340]), color: [0.9, 0.9, 0.9] },
        { op: 'stroke', segments: rectSegments([300, 300, 400, 350]) },
        {
          op: 'stroke',
          segments: [
            { type: 'M', p: [0, 0] },
            { type: 'L', p: [10, 10] },
          ],
        },
        { op: 'clip', segments: lineSegments([0, 0], [100, 0]) },
      ],
    });
    const s = summarizePaths(model);
    const h = s.rules.filter((r) => r.orient === 'h');
    const v = s.rules.filter((r) => r.orient === 'v');
    // 격자 가로 2 + 얇은 채움 1 + 테두리 위·아래 2, 세로 3 + 테두리 좌·우 2.
    expect(h).toHaveLength(5);
    expect(v).toHaveLength(5);
    expect(h.find((r) => r.fromBox)!.y0).toBeCloseTo(200.5);
    expect(s.boxes).toHaveLength(1);
    expect(s.boxes[0]!.color).toEqual([0.9, 0.9, 0.9]);
    expect(s.shapes.filter((x) => x.complex)).toHaveLength(1);
  });
});
