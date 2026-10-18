import { describe, expect, it } from 'vitest';
import { parseContentOps, spliceBytes } from '../src/index.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('parseContentOps', () => {
  it('연산자·피연산자·바이트 범위', () => {
    const src = 'q 1 0 0 1 56 300 cm /Fx1 Do Q';
    const ops = parseContentOps(enc(src));
    expect(ops.map((o) => o.op)).toEqual(['q', 'cm', 'Do', 'Q']);
    const cm = ops[1]!;
    expect(cm.operands.map((t) => t.value)).toEqual([1, 0, 0, 1, 56, 300]);
    expect(src.slice(cm.start, cm.end)).toBe('1 0 0 1 56 300 cm');
    const name = ops[2]!.operands[0]!;
    expect(name).toMatchObject({ kind: 'name', value: 'Fx1' });
    expect(src.slice(name.start, name.end)).toBe('/Fx1');
  });

  it('문자열(중첩 괄호·이스케이프)·16진 문자열·배열·사전·주석·이름 #xx', () => {
    const src =
      'BT (a (b) \\) c) Tj <0041> Tj [(x) -20 (y)] TJ ET % 주석 Do\n' +
      '/P <</MCID 3>> BDC /A#20B Do EMC .5 -1. 2 d0';
    const ops = parseContentOps(enc(src));
    expect(ops.map((o) => o.op)).toEqual(['BT', 'Tj', 'Tj', 'TJ', 'ET', 'BDC', 'Do', 'EMC', 'd0']);
    expect(ops[3]!.operands.map((t) => t.kind)).toEqual([
      'array-open',
      'string',
      'number',
      'string',
      'array-close',
    ]);
    expect(ops[6]!.operands[0]!.value).toBe('A B');
    expect(ops[8]!.operands.map((t) => t.value)).toEqual([0.5, -1, 2]);
  });

  it('인라인 이미지 데이터는 하나의 BI 연산으로 건너뛴다', () => {
    const src = 'q BI /W 2 /H 1 /CS /G /BPC 8 ID \x00EI\xff EI Q /Im Do';
    const ops = parseContentOps(enc(src));
    expect(ops.map((o) => o.op)).toEqual(['q', 'BI', 'Q', 'Do']);
  });

  it('spliceBytes', () => {
    expect(dec(spliceBytes(enc('/Fx1 Do'), 0, 4, '/FxE0'))).toBe('/FxE0 Do');
  });
});
