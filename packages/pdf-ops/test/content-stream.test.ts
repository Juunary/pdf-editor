import { describe, expect, it } from 'vitest';
import {
  decodeStringToken,
  parseContentOps,
  parseContentOpsLenient,
  spliceBytes,
} from '../src/index.js';

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

  it('필터 없는 인라인 이미지는 데이터 길이를 계산해 데이터 안의 EI 를 건너뛴다', () => {
    // W 3 H 1 G 8bit = 3바이트 "EI " 가 데이터. MuPDF 와 같이 그 뒤의 EI 에서 끝난다.
    const src = 'BI /W 3 /H 1 /CS /G /BPC 8 ID EI  EI Q';
    const ops = parseContentOps(enc(src));
    expect(ops.map((o) => o.op)).toEqual(['BI', 'Q']);
    expect(src.slice(ops[0]!.start, ops[0]!.end)).toBe('BI /W 3 /H 1 /CS /G /BPC 8 ID EI  EI');
    expect(ops[0]!.inlineDict!.map((t) => t.value)).toEqual(['W', 3, 'H', 1, 'CS', 'G', 'BPC', 8]);
  });

  it('parseContentOpsLenient: 오류 전 연산과 오류 위치', () => {
    const r = parseContentOpsLenient(enc('q 1 0 0 1 0 0 cm (open Tj'));
    expect(r.ops.map((o) => o.op)).toEqual(['q', 'cm']);
    expect(r.error?.message).toMatch('닫히지 않은 문자열');
    expect(() => parseContentOps(enc('(open'))).toThrow();
  });

  it('decodeStringToken: 이스케이프·줄바꿈·8진수·16진 홀수 자리와 원본 위치', () => {
    // a \\ b \n c \<CRLF>(이어 쓰기) d \101 \7 x \q <CRLF> e <CR> f
    const lit = String.raw`(a\\b\nc` + '\\\r\n' + String.raw`d\101\7x\q` + '\r\ne\rf)';
    const src = `${lit} <4 1 4> Tj`;
    const bytes = enc(src);
    const [litTok, hexTok] = parseContentOps(bytes)[0]!.operands;
    const d = decodeStringToken(bytes, litTok!);
    expect(Array.from(d.data)).toEqual([
      0x61, 0x5c, 0x62, 0x0a, 0x63, 0x64, 0x41, 0x07, 0x78, 0x71, 0x0a, 0x65, 0x0a, 0x66,
    ]);
    expect(src.slice(d.starts[6], d.ends[6])).toBe(String.raw`\101`);
    expect(src.slice(d.starts[10], d.ends[10])).toBe('\r\n');
    const h = decodeStringToken(bytes, hexTok!);
    expect(Array.from(h.data)).toEqual([0x41, 0x40]);
    expect(src.slice(h.starts[0], h.ends[0])).toBe('4 1');
  });

  it('spliceBytes', () => {
    expect(dec(spliceBytes(enc('/Fx1 Do'), 0, 4, '/FxE0'))).toBe('/FxE0 Do');
  });
});
