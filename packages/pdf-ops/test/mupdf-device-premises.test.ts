import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { brief, recordDevice } from './helpers/device-log.js';

/**
 * M1 계약 3절 검증 전제 V1–V5 를 MuPDF 1.28.1 Device 콜백으로 확인한다(docs/m1-pdf-ops.md 2절).
 * 기대값은 실측 동작이다. 계약과 어긋나는 항목(V3·V5)은 테스트 이름에 "계약 불일치" 를 붙였다.
 */

interface PageSpec {
  /** 문자열이면 단일 /Contents, 배열이면 /Contents 배열. */
  content: string | string[];
  resources?: (doc: mupdf.PDFDocument, ocg: mupdf.PDFObject) => Record<string, unknown>;
}

/** 꺼진 OCG 하나(/OCProperties /D /OFF)와 Helvetica /F1 을 둔 1쪽 문서를 만들어 Device 기록을 돌려준다. */
function record(spec: PageSpec) {
  const doc = new mupdf.PDFDocument();
  const F1 = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  const ocg = doc.addObject({ Type: 'OCG', Name: 'Hidden' });
  const ocp = doc.newDictionary();
  const ocgs = doc.newArray();
  ocgs.push(ocg);
  ocp.put('OCGs', ocgs);
  const d = doc.newDictionary();
  const off = doc.newArray();
  off.push(ocg);
  d.put('OFF', off);
  ocp.put('D', d);
  doc.getTrailer().get('Root').put('OCProperties', ocp);
  const res = { Font: { F1 }, Properties: { OC1: ocg }, ...spec.resources?.(doc, ocg) };
  const contents = Array.isArray(spec.content) ? spec.content : [spec.content];
  const pageObj = doc.addPage([0, 0, 612, 792], 0, res, contents[0]!);
  if (contents.length > 1) {
    const arr = doc.newArray();
    for (const c of contents) arr.push(doc.addStream(c, {}));
    pageObj.put('Contents', arr);
  }
  doc.insertPage(-1, pageObj);
  const saved = doc.saveToBuffer('').asUint8Array().slice();
  const reopened = mupdf.Document.openDocument(saved, 'application/pdf');
  return recordDevice(reopened.loadPage(0));
}

const bt = (body: string) => `BT /F1 12 Tf 50 700 Td ${body} ET 0 Tr`;
const hiddenBt = (body: string) => `/OC /OC1 BDC ${bt(body)} EMC`;
const run = (content: string | string[], resources?: PageSpec['resources']) =>
  brief(record({ content, resources }));

describe('V1: 콜백은 Form 재귀를 포함한 콘텐츠 실행 순서로 온다', () => {
  it('/Contents 배열 3개 + 중첩 Form. Form Do 는 BBox clipPath 를 먼저 보낸다', () => {
    const ev = run(
      [bt('(P1) Tj'), 'q 1 0 0 1 50 400 cm /Fx1 Do Q', `${bt('(P2) Tj')} 0 0 5 5 re f`],
      (doc) => {
        const F1 = doc.addSimpleFont(new mupdf.Font('Helvetica'));
        const fx2 = doc.addStream(`${bt('(N2) Tj')} 0 0 10 10 re f`, {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 100, 100],
          Resources: { Font: { F1 } },
        });
        const fx1 = doc.addStream(
          `${bt('(F1a) Tj')} q 1 0 0 1 30 0 cm /Fx2 Do Q ${bt('(F1b) Tj')}`,
          {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 200, 100],
            Matrix: [2, 0, 0, 2, 0, 0],
            Resources: { Font: { F1 }, XObject: { Fx2: fx2 } },
          },
        );
        return { XObject: { Fx1: fx1 } };
      },
    );
    expect(ev).toEqual([
      'fill:P1',
      'clipPath',
      'fill:F1a',
      'clipPath',
      'fill:N2',
      'fillPath',
      'fill:F1b',
      'fill:P2',
      'fillPath',
    ]);
  });
});

describe('V2: 여러 Tj/TJ 를 한 콜백으로 묶되 글리프 순서는 보존한다', () => {
  it('Tj·TJ·Td·T*·\'·"·Tf 변경·q 는 묶이고, 색·Q 는 나눈다', () => {
    expect(
      run(bt('14 TL (Ab) Tj [(C) -500 (d)] TJ T* (E) Tj (f) \' 1 2 (g) " /F1 9 Tf (h) Tj')),
    ).toEqual(['fill:AbCdEfgh']);
    expect(run(bt('(Ab) Tj 1 0 0 rg (Cd) Tj q (Ef) Tj Q (Gh) Tj'))).toEqual([
      'fill:Ab',
      'fill:CdEf',
      'fill:Gh',
    ]);
  });

  it('BT 안의 경로 칠하기는 묶인 텍스트보다 먼저 온다(번호 체계가 달라 매칭에는 영향 없음)', () => {
    expect(run(bt('(Ab) Tj 0 0 10 10 re f (Cd) Tj'))).toEqual(['fillPath', 'fill:AbCd']);
  });
});

describe('V3: 텍스트 렌더 방식별 콜백', () => {
  it('Tr 0–3: fill / stroke / fill+stroke(같은 객체) / ignore', () => {
    expect(run(bt('(A) Tj 1 Tr (B) Tj 2 Tr (C) Tj 3 Tr (D) Tj'))).toEqual([
      'fill:A',
      'stroke:B',
      'fill:C',
      'stroke=:C',
      'ignore:D',
    ]);
  });

  it('계약 불일치: Tr 4–6 의 클립은 표시 콜백과 다른 텍스트 객체로 ET 에서 온다', () => {
    expect(run(bt('4 Tr (Ab) Tj (Cd) Tj'))).toEqual(['fill:AbCd', 'clip:AbCd']);
    expect(run(bt('5 Tr (Ab) Tj'))).toEqual(['stroke:Ab', 'clip:Ab']);
    expect(run(bt('6 Tr (Ab) Tj'))).toEqual(['fill:Ab', 'stroke=:Ab', 'clip:Ab']);
    expect(run(bt('7 Tr (Ab) Tj'))).toEqual(['clip:Ab']);
  });

  it('ET 재전송 글리프의 gid·trm 은 표시 콜백과 비트 단위로 같다', () => {
    const ev = record({
      content: bt(
        '0.9 0.1 -0.1 0.9 50.17 700.33 Tm 0.7 Tc 1.3 Tw 87 Tz 2 Ts 4 Tr (A b) Tj [(C) -123.4 (d)] TJ',
      ),
    });
    const [fill, clip] = ev.filter((e) => e.pointer !== undefined);
    expect(fill!.kind).toBe('fillText');
    expect(clip!.kind).toBe('clipText');
    expect(clip!.pointer).not.toBe(fill!.pointer);
    expect(clip!.glyphs).toEqual(fill!.glyphs);
  });

  it('ET 재전송 = 그 BT 의 Tr 4–7 글리프 전체. BT 마지막 글리프의 Tr 이 4–7 이면 clip, 3 이면 ignore, 0–2 이면 없음', () => {
    expect(run(bt('7 Tr (A) Tj 4 Tr (B) Tj'))).toEqual(['fill:B', 'clip:AB']);
    expect(run(bt('7 Tr (A) Tj 0 Tr (B) Tj 5 Tr (C) Tj'))).toEqual([
      'fill:B',
      'stroke:C',
      'clip:AC',
    ]);
    expect(run(bt('4 Tr (Ab) Tj 0 Tr (Xy) Tj 7 Tr (Cd) Tj 3 Tr (In) Tj'))).toEqual([
      'fill:Ab',
      'fill:Xy',
      'ignore:In',
      'ignore:AbCd',
    ]);
    expect(run(bt('7 Tr (A) Tj 0 Tr (B) Tj'))).toEqual(['fill:B']);
    expect(run(bt('4 Tr (A) Tj 1 Tr (B) Tj'))).toEqual(['fill:A', 'stroke:B']);
    expect(run(bt('7 Tr (A) Tj 2 Tr (B) Tj'))).toEqual(['fill:B', 'stroke=:B']);
  });

  it('"마지막 글리프의 Tr" 은 글리프를 낸 Tr 이다(빈 문자열·Tr 변경만으로는 바뀌지 않음)', () => {
    expect(run(bt('7 Tr (A) Tj 0 Tr'))).toEqual(['clip:A']);
    expect(run(bt('7 Tr (A) Tj 0 Tr () Tj'))).toEqual(['clip:A']);
    expect(run(bt('7 Tr (A) Tj 1 0 0 rg (B) Tj'))).toEqual(['clip:AB']);
  });
});

describe('V4: 채움+선 연산은 fillPath → strokePath 콜백 2개다', () => {
  it('B·B*·b·b*', () => {
    expect(run('0 0 9 9 re B 0 0 9 9 re B* 0 0 9 9 re b 0 0 9 9 re b*')).toEqual([
      'fillPath',
      'strokePath',
      'fillPath',
      'strokePath',
      'fillPath',
      'strokePath',
      'fillPath',
      'strokePath',
    ]);
  });

  it('빈 경로도 콜백을 보낸다: f(경로 없음)·m S·0 크기 re f. n 은 W 없으면 없음', () => {
    expect(run('f 50 50 m S 60 60 m 70 70 l n 0 0 0 0 re f')).toEqual([
      'fillPath',
      'strokePath',
      'fillPath',
    ]);
  });
});

describe('V5: 꺼진 선택적 콘텐츠', () => {
  it('Tr 0–2 텍스트·경로·이미지·셰이드는 오지 않는다', () => {
    const ev = run(
      '/OC /OC1 BDC BT /F1 12 Tf 50 600 Td (H0) Tj 1 Tr (H1) Tj 2 Tr (H2) Tj ET 0 Tr 10 10 20 20 re f q 50 0 0 50 0 0 cm /Im Do Q /Sh sh EMC',
      (doc) => ({
        XObject: {
          Im: doc.addImage(
            new mupdf.Image(new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 2, 2], false)),
          ),
        },
        Shading: {
          Sh: {
            ShadingType: 2,
            ColorSpace: 'DeviceRGB',
            Coords: [0, 0, 100, 0],
            Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 },
          },
        },
      }),
    );
    expect(ev).toEqual([]);
  });

  it('/OC 가 꺼진 Form XObject 는 BBox 클립까지 전부 오지 않는다', () => {
    const ev = run('/FxH Do 0 0 1 1 re f', (doc, ocg) => ({
      XObject: {
        FxH: doc.addStream('0 0 10 10 re W n 0 0 10 10 re f', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 100, 100],
          OC: ocg,
        }),
      },
    }));
    expect(ev).toEqual(['fillPath']);
  });

  it('계약 불일치: 꺼진 /OC 안에서도 클립(W n·Form BBox)과 Tr 3·ET 재전송 텍스트는 온다', () => {
    const ev = run(
      `/OC /OC1 BDC q 10 10 30 30 re W n Q /Fx Do EMC ${hiddenBt('3 Tr (H3) Tj')}`,
      (doc) => ({
        XObject: {
          Fx: doc.addStream('0 0 10 10 re f', {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 100, 100],
          }),
        },
      }),
    );
    expect(ev).toEqual(['clipPath', 'clipPath', 'ignore:H3']);
    expect(run(hiddenBt('4 Tr (H4) Tj 7 Tr (H7) Tj 3 Tr (H3) Tj 0 Tr'))).toEqual([
      'ignore:H3',
      'ignore:H4H7',
    ]);
    expect(run(hiddenBt('1 Tr (S1) Tj 2 Tr (S2) Tj 5 Tr (S5) Tj 6 Tr (S6) Tj'))).toEqual([
      'clip:S5S6',
    ]);
  });
});

describe('계약 규칙과 충돌하지 않는 에뮬레이션 대상(paintSeq·glyphSeq 계산에 반영)', () => {
  const shading = {
    ShadingType: 2,
    ColorSpace: 'DeviceRGB',
    Coords: [0, 0, 100, 0],
    Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 },
  };

  it('셰이딩 패턴: 칠하기는 clip + fillShade, 텍스트는 clipText(표시 시점) + fillShade', () => {
    const ev = run(
      '/Pattern cs /P scn /Pattern CS /P SCN 10 10 50 50 re f 100 10 50 50 re S 200 10 50 50 re B BT /F1 20 Tf 50 700 Td (Ab) Tj ET',
      (doc) => ({
        Pattern: { P: doc.addObject({ Type: 'Pattern', PatternType: 2, Shading: shading }) },
      }),
    );
    expect(ev).toEqual([
      'clipPath',
      'fillShade',
      'clipStrokePath',
      'fillShade',
      'clipPath',
      'fillShade',
      'clipStrokePath',
      'fillShade',
      'clip:Ab',
      'fillShade',
    ]);
  });

  it('타일링 패턴: clip + 타일 내용 콜백(beginTile 이 0 을 돌려주면 1회)', () => {
    const ev = run('/Pattern cs /P scn 10 10 50 50 re f', (doc) => {
      const F1 = doc.addSimpleFont(new mupdf.Font('Helvetica'));
      return {
        Pattern: {
          P: doc.addStream('0 0 5 5 re f BT /F1 4 Tf (x) Tj ET', {
            Type: 'Pattern',
            PatternType: 1,
            PaintType: 1,
            TilingType: 1,
            BBox: [0, 0, 10, 10],
            XStep: 10,
            YStep: 10,
            Resources: { Font: { F1 } },
          }),
        },
      };
    });
    expect(ev).toEqual(['clipPath', 'beginTile', 'fillPath', 'fill:x']);
  });

  it('SMask: 칠하기마다 마스크 그룹(BBox clip + 내용)을 다시 실행한다', () => {
    const ev = run('q /S1 gs 10 10 50 50 re f 100 10 50 50 re f Q 0 0 1 1 re f', (doc) => {
      const g = doc.addStream('0.5 g 0 0 300 300 re f', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 612, 792],
        Group: { S: 'Transparency', CS: 'DeviceGray' },
      });
      return { ExtGState: { S1: { SMask: { Type: 'Mask', S: 'Luminosity', G: g } } } };
    });
    expect(ev).toEqual([
      'clipPath',
      'fillPath',
      'fillPath',
      'clipPath',
      'fillPath',
      'fillPath',
      'fillPath',
    ]);
  });

  it('Type3: Tr 1 은 fill, Tr 7 은 ET 에서 ignore', () => {
    const ev = run(
      'BT /T 20 Tf 50 700 Td 1 Tr (A) Tj ET BT /T 20 Tf 50 650 Td 7 Tr (B) Tj ET 0 Tr',
      (doc) => ({
        Font: {
          F1: doc.addSimpleFont(new mupdf.Font('Helvetica')),
          T: doc.addObject({
            Type: 'Font',
            Subtype: 'Type3',
            FontBBox: [0, 0, 1000, 1000],
            FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
            CharProcs: {
              a: doc.addStream('600 0 0 0 500 500 d1 0 0 500 500 re f', {}),
              b: doc.addStream('700 0 0 0 500 500 d1 0 0 250 500 re f', {}),
            },
            Encoding: { Type: 'Encoding', Differences: [65, 'a', 'b'] },
            FirstChar: 65,
            LastChar: 66,
            Widths: [600, 700],
            Resources: {},
          }),
        },
      }),
    );
    expect(ev).toEqual(['fill:a', 'ignore:b']);
  });

  it('이미지·인라인 이미지·마스크 인라인 이미지·클립 안 sh', () => {
    const ev = run(
      'q 50 0 0 50 100 100 cm /Im Do Q q 10 0 0 10 200 200 cm BI /W 1 /H 1 /CS /G /BPC 8 ID \x80 EI Q q 10 0 0 10 220 200 cm BI /W 1 /H 1 /IM true ID \x80 EI Q q 0 0 50 50 re W n /Sh sh Q',
      (doc) => ({
        XObject: {
          Im: doc.addImage(
            new mupdf.Image(new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 2, 2], false)),
          ),
        },
        Shading: { Sh: shading },
      }),
    );
    expect(ev).toEqual(['fillImage', 'fillImage', 'fillImageMask', 'clipPath', 'fillShade']);
  });
});
