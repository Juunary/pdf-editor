import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import type { SourceMap, SourceOp } from '@pdf-editor/shared-types';
import { buildSourceMap } from '../src/index.js';

/** M3 optional fields (contract section 4 source-map.ts): TextShowInfo.tlm, SourceOp.state, SourceOp.markedContent. */
function docOf(content: string, extra: Record<string, unknown> = {}): mupdf.PDFDocument {
  const src = new mupdf.PDFDocument();
  const F1 = src.addSimpleFont(new mupdf.Font('Helvetica'));
  const GS1 = src.addObject({ Type: 'ExtGState', ca: 0.5 });
  const GS2 = src.addObject({ Type: 'ExtGState', CA: 0.25 });
  const P1 = src.addObject({ MCID: 7, ActualText: 'alt' });
  src.insertPage(
    -1,
    src.addPage(
      [0, 0, 400, 300],
      0,
      {
        Font: { F1 },
        ExtGState: { GS1, GS2 },
        ColorSpace: { CS0: 'DeviceRGB' },
        Properties: { P1 },
        ...extra,
      },
      content,
    ),
  );
  return mupdf.Document.openDocument(
    src.saveToBuffer('').asUint8Array().slice(),
    'application/pdf',
  ) as mupdf.PDFDocument;
}

const shows = (map: SourceMap) => map.ops.filter((o) => o.kind === 'text-show');
const opById = (map: SourceMap, id: number) => map.ops[id]!;

describe('SourceMap M3 optional fields', () => {
  it("tlm: text line matrix just before the operation (Td accumulated, for ' the value before T*)", () => {
    const doc = docOf("BT /F1 10 Tf 12 TL 1 0 0 1 50.5 200.25 Tm (a) Tj 10 -20 Td (b) Tj (c) ' ET");
    const map = buildSourceMap(doc, 0);
    const [a, b, c] = shows(map);
    expect(a!.text!.tlm).toEqual([1, 0, 0, 1, 50.5, 200.25]);
    expect(b!.text!.tlm).toEqual([1, 0, 0, 1, 60.5, 180.25]);
    // ' executes T* first, but tlm is the value just before the operation.
    expect(c!.text!.tlm).toEqual([1, 0, 0, 1, 60.5, 180.25]);
    expect(c!.text!.leading).toBe(12);
  });

  it('state.fillColorOps: cs+scn both, rg one, restored by q/Q', () => {
    const doc = docOf(
      'BT /F1 10 Tf 10 10 Td (d) Tj ET /CS0 cs 0.1 0.2 0.3 scn BT /F1 10 Tf 10 30 Td (e) Tj ET ' +
        'q 1 0 0 rg BT /F1 10 Tf 10 50 Td (f) Tj ET Q BT /F1 10 Tf 10 70 Td (g) Tj ET',
    );
    const map = buildSourceMap(doc, 0);
    const [d, e, f, g] = shows(map);
    expect(d!.state!.fillColorOps).toEqual([]);
    expect(e!.state!.fillColorOps.map((id) => opById(map, id).op)).toEqual(['cs', 'scn']);
    expect(f!.state!.fillColorOps.map((id) => opById(map, id).op)).toEqual(['rg']);
    expect(g!.state!.fillColorOps).toEqual(e!.state!.fillColorOps);
  });

  it('state.extGStateOps: gs accumulated from outer to inner, restored by Q', () => {
    const doc = docOf(
      '/GS1 gs q /GS2 gs BT /F1 10 Tf 10 10 Td (h) Tj ET Q BT /F1 10 Tf 10 30 Td (i) Tj ET /GSX gs',
    );
    const map = buildSourceMap(doc, 0);
    const [h, i] = shows(map);
    const names = (op: SourceOp) =>
      op.state!.extGStateOps.map((id) => opById(map, id).op + '@' + id);
    expect(h!.state!.extGStateOps).toHaveLength(2);
    expect(i!.state!.extGStateOps).toHaveLength(1);
    expect(names(i!)[0]).toBe(names(h!)[0]);
  });

  it('state.clipRect: intersection of rectangular clips (page space), not a rectangle -> null, none -> page bounds', () => {
    const doc = docOf(
      'BT /F1 10 Tf 10 10 Td (j) Tj ET ' +
        'q 20 20 200 100 re W n 50 0 300 300 re W n BT /F1 10 Tf 60 60 Td (k) Tj ET Q ' +
        'q 0 0 m 100 0 l 50 100 l h W n BT /F1 10 Tf 40 20 Td (l) Tj ET Q',
    );
    const map = buildSourceMap(doc, 0);
    const [j, k, l] = shows(map);
    expect(j!.state!.clipRect).toEqual([0, 0, 400, 300]);
    // User space [50,20]-[220,120] -> page space (y flipped, height 300)
    const r = k!.state!.clipRect!;
    expect(r.map((v) => Math.round(v * 1000) / 1000)).toEqual([50, 180, 220, 280]);
    expect(l!.state!.clipRect).toBeNull();
  });

  it('state.clipRect: the Form BBox enters the clip', () => {
    const src = new mupdf.PDFDocument();
    const F1 = src.addSimpleFont(new mupdf.Font('Helvetica'));
    const form = src.addStream('BT /F1 10 Tf 5 5 Td (m) Tj ET', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 50, 40],
      Resources: { Font: { F1 } },
    });
    src.insertPage(
      -1,
      src.addPage([0, 0, 400, 300], 0, { XObject: { X0: form } }, 'q 1 0 0 1 100 100 cm /X0 Do Q'),
    );
    const doc = mupdf.Document.openDocument(
      src.saveToBuffer('').asUint8Array().slice(),
      'application/pdf',
    ) as mupdf.PDFDocument;
    const map = buildSourceMap(doc, 0);
    const m = shows(map)[0]!;
    expect(m.formPath).toHaveLength(1);
    expect(m.state!.clipRect!.map(Math.round)).toEqual([100, 160, 150, 200]);
  });

  it('markedContent: BDC (inline MCID, ActualText), Properties name, BMC, whether inside BT', () => {
    const doc = docOf(
      '/P <</MCID 3>> BDC BT /F1 10 Tf 10 10 Td (n) Tj /Span <</ActualText (x)>> BDC (o) Tj EMC ET EMC ' +
        '/Q /P1 BDC /Artifact BMC BT /F1 10 Tf 10 40 Td (p) Tj ET EMC EMC BT /F1 10 Tf 10 60 Td (q) Tj ET',
    );
    const map = buildSourceMap(doc, 0);
    const [n, o, p, q] = shows(map);
    expect(n!.markedContent).toEqual([
      expect.objectContaining({ tag: 'P', mcid: 3, actualText: false, insideText: false }),
    ]);
    expect(o!.markedContent!.map((m) => [m.tag, m.mcid, m.actualText, m.insideText])).toEqual([
      ['P', 3, false, false],
      ['Span', null, true, true],
    ]);
    expect(opById(map, o!.markedContent![1]!.opId).op).toBe('BDC');
    expect(p!.markedContent!.map((m) => [m.tag, m.mcid, m.actualText])).toEqual([
      ['Q', 7, true],
      ['Artifact', null, false],
    ]);
    expect(q!.markedContent).toEqual([]);
    expect(n!.mcids).toEqual([3]);
  });
});
