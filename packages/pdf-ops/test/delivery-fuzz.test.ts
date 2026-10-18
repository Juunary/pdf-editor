import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { buildSourceMapImpl } from '../src/content-interp.js';
import { deliveryTrace } from './helpers/device-log.js';

/**
 * 인터프리터 전달 순서열 = MuPDF Device 전달 순서열 회귀 테스트(docs/m1-pdf-ops.md 5.3).
 * 고정 시드 무작위 콘텐츠(텍스트 Tr 0–7, 셰이딩·타일링 패턴, 꺼진·켜진 /OC, MCID, Form, 이미지,
 * 인라인 이미지, sh, q/Q·cm·W·gs)마다 텍스트 도착(종류·글리프 수)과 칠하기 순서를 비교한다.
 * 정책과 무관한 비교다(번호는 이 순서열의 함수). 알려진 불일치는 타일링 패턴 색 텍스트의 타일 수 판정(R2)뿐이다.
 */
const SEEDS = 400;
const KNOWN_R2 = [44, 132, 288, 390];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const shading = {
  ShadingType: 2,
  ColorSpace: 'DeviceRGB',
  Coords: [0, 0, 100, 0],
  Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 },
};

function randomContent(seed: number): string {
  const r = rng(seed);
  const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)]!;
  const n = (lo: number, hi: number) => +(lo + r() * (hi - lo)).toFixed(2);
  const parts: string[] = [];
  let inBT = false;
  let depth = 0;
  let bdc = 0;
  const kinds = [
    'text',
    'text',
    'text',
    'tr',
    'path',
    'path',
    'clip',
    'q',
    'Q',
    'color',
    'pat',
    'bt',
    'et',
    'bdc',
    'emc',
    'do',
    'img',
    'sh',
    'cm',
    'gs',
  ] as const;
  for (let k = 0; k < 40; k++) {
    const c = pick(kinds);
    if (c === 'bt' && !inBT) {
      parts.push(`BT /F${pick([1, 2, 3])} ${n(6, 20)} Tf ${n(20, 500)} ${n(20, 700)} Td`);
      inBT = true;
    } else if (c === 'et' && inBT) {
      parts.push('ET');
      inBT = false;
    } else if (c === 'text' && inBT) {
      parts.push(
        pick([
          `(${pick(['ab', 'Hi there', 'x y z', 'Q'])}) Tj`,
          `[(A) ${n(-300, 300)} (b c)] TJ`,
          '0 -12 Td (L) Tj',
          `${n(-1, 3)} Tc (cc) Tj`,
          `${n(50, 150)} Tz (zz) Tj`,
          '14 TL T* (t) Tj',
        ]),
      );
    } else if (c === 'tr') parts.push(`${pick([0, 1, 2, 3, 4, 5, 6, 7])} Tr`);
    else if (c === 'path')
      parts.push(
        `${n(0, 500)} ${n(0, 700)} ${n(0, 60)} ${n(0, 60)} re ${pick(['f', 'S', 'B', 'b*', 'n', 'f*', 's'])}`,
      );
    else if (c === 'clip')
      parts.push(
        `${n(0, 500)} ${n(0, 700)} ${n(1, 300)} ${n(1, 300)} re ${pick(['W n', 'W* n', 'W f'])}`,
      );
    else if (c === 'q') {
      parts.push('q');
      depth++;
    } else if (c === 'Q' && depth > 0) {
      parts.push('Q');
      depth--;
    } else if (c === 'color') parts.push(pick(['1 0 0 rg', '0 g', '0 0 1 RG', '0.5 G']));
    else if (c === 'pat')
      parts.push(
        pick([
          '/Pattern cs /SP scn',
          '/Pattern CS /SP SCN',
          '/Pattern cs /TP scn',
          '/Pattern CS /TP SCN',
        ]),
      );
    else if (c === 'bdc') {
      parts.push(pick(['/OC /OC1 BDC', '/OC /On BDC', '/P <</MCID 2>> BDC', '/Span BMC']));
      bdc++;
    } else if (c === 'emc' && bdc > 0) {
      parts.push('EMC');
      bdc--;
    } else if (c === 'do')
      parts.push(pick(['/Fx Do', 'q 0.5 0 0 0.5 100 100 cm /Fx Do Q', '/FxH Do']));
    else if (c === 'img')
      parts.push(
        pick([
          'q 20 0 0 20 50 50 cm /Im Do Q',
          'q 20 0 0 20 80 80 cm BI /W 2 /H 1 /CS /G /BPC 8 ID ab EI Q',
          'q 9 0 0 9 1 1 cm BI /IM true /W 8 /H 1 ID z EI Q',
        ]),
      );
    else if (c === 'sh') parts.push('/Sh sh');
    else if (c === 'cm' && !inBT)
      parts.push(
        `${n(0.5, 1.5)} ${n(-0.3, 0.3)} ${n(-0.3, 0.3)} ${n(0.5, 1.5)} ${n(-20, 20)} ${n(-20, 20)} cm`,
      );
    else if (c === 'gs') parts.push('/G1 gs');
  }
  if (inBT) parts.push('ET');
  return parts.join('\n');
}

function randomDoc(seed: number): mupdf.PDFDocument {
  const doc = new mupdf.PDFDocument();
  const F1 = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  const F2 = doc.addFont(new mupdf.Font('Times-Roman'));
  const F3 = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier' });
  const ocg = doc.addObject({ Type: 'OCG', Name: 'H' });
  const on = doc.addObject({ Type: 'OCG', Name: 'On' });
  const ocp = doc.newDictionary();
  const arr = doc.newArray();
  arr.push(ocg);
  arr.push(on);
  ocp.put('OCGs', arr);
  const D = doc.newDictionary();
  const off = doc.newArray();
  off.push(ocg);
  D.put('OFF', off);
  ocp.put('D', D);
  doc.getTrailer().get('Root').put('OCProperties', ocp);
  const res = {
    Font: { F1, F2, F3 },
    Properties: { OC1: ocg, On: on },
    XObject: {
      Fx: doc.addStream('BT /F1 9 Tf 5 5 Td (form) Tj ET 0 0 30 30 re f 4 Tr', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 100, 100],
        Resources: { Font: { F1 } },
      }),
      FxH: doc.addStream('0 0 10 10 re f', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 100, 100],
        OC: ocg,
      }),
      Im: doc.addImage(
        new mupdf.Image(new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 2, 2], false)),
      ),
    },
    Pattern: {
      SP: doc.addObject({ Type: 'Pattern', PatternType: 2, Shading: shading }),
      TP: doc.addStream('0 0 4 4 re f', {
        Type: 'Pattern',
        PatternType: 1,
        PaintType: 1,
        TilingType: 1,
        BBox: [0, 0, 8, 8],
        XStep: 8,
        YStep: 8,
      }),
    },
    Shading: { Sh: shading },
    ExtGState: { G1: { ca: 0.7, LW: 2 } },
  };
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, randomContent(seed)));
  return mupdf.Document.openDocument(
    doc.saveToBuffer('').asUint8Array().slice(),
    'application/pdf',
  ) as mupdf.PDFDocument;
}

describe('전달 순서열 퍼징', () => {
  it(`고정 시드 ${SEEDS}쪽: 알려진 R2 외 전부 일치`, () => {
    const mismatched: number[] = [];
    let aborted = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const doc = randomDoc(seed);
      const trace: string[] = [];
      const map = buildSourceMapImpl(doc, 0, 8, 'first-arrival', trace);
      let dev: string[];
      try {
        dev = deliveryTrace(doc.loadPage(0));
      } catch (e) {
        // MuPDF: 클립 텍스트 누적 중 cm 은 페이지 해석 예외. 인터프리터도 같은 지점에서 멈춘다.
        expect(String(e)).toMatch('CTM CHANGE IN CLIP TEXT');
        expect(map.errors.map((x) => x.message)).toContain(
          'MuPDF: 클립 텍스트 누적 중 cm(해석 중단)',
        );
        aborted++;
        continue;
      }
      const interp = trace.map((t) => t.replace(/:[NR]+$/, ''));
      if (interp.join(' ') !== dev.join(' ')) mismatched.push(seed);
    }
    expect(mismatched).toEqual(KNOWN_R2);
    expect(aborted).toBeGreaterThan(0);
  });
});
