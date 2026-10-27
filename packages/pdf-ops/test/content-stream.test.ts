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
  it('operators, operands, byte ranges', () => {
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

  it('strings (nested parentheses, escapes), hex strings, arrays, dictionaries, comments, names #xx', () => {
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

  it('inline image data is skipped as a single BI operation', () => {
    const src = 'q BI /W 2 /H 1 /CS /G /BPC 8 ID \x00EI\xff EI Q /Im Do';
    const ops = parseContentOps(enc(src));
    expect(ops.map((o) => o.op)).toEqual(['q', 'BI', 'Q', 'Do']);
  });

  it('an unfiltered inline image computes the data length and skips the EI inside the data', () => {
    // W 3 H 1 G 8bit = 3 bytes "EI " is the data. As in MuPDF, it ends at the EI after that.
    const src = 'BI /W 3 /H 1 /CS /G /BPC 8 ID EI  EI Q';
    const ops = parseContentOps(enc(src));
    expect(ops.map((o) => o.op)).toEqual(['BI', 'Q']);
    expect(src.slice(ops[0]!.start, ops[0]!.end)).toBe('BI /W 3 /H 1 /CS /G /BPC 8 ID EI  EI');
    expect(ops[0]!.inlineDict!.map((t) => t.value)).toEqual(['W', 3, 'H', 1, 'CS', 'G', 'BPC', 8]);
  });

  it('parseContentOpsLenient: operations before the error and the error position', () => {
    const r = parseContentOpsLenient(enc('q 1 0 0 1 0 0 cm (open Tj'));
    expect(r.ops.map((o) => o.op)).toEqual(['q', 'cm']);
    expect(r.error?.message).toMatch('닫히지 않은 문자열');
    expect(() => parseContentOps(enc('(open'))).toThrow();
  });

  it('decodeStringToken: escapes, line breaks, octal, odd hex digit count, and source position', () => {
    // a \\ b \n c \<CRLF>(continuation) d \101 \7 x \q <CRLF> e <CR> f
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
