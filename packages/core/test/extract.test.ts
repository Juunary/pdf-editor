import { existsSync, readFileSync } from 'node:fs';
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PdfSession, extractPageDetailed } from '../src/index.js';
import * as mupdf from 'mupdf';
import type { PageModel } from '@pdf-editor/shared-types';
import { readStructuredText } from '../src/extract-stext.js';
import { buildPdf, hexGlyphs, koreanFont, type PageSpec } from './pdf-fixtures.js';

function open(pages: Array<string | PageSpec>): PdfSession {
  const s = new PdfSession();
  s.open(buildPdf(pages));
  return s;
}

function extract(content: string | PageSpec, includePathSegments = false): PageModel {
  const s = open([content]);
  const model = s.extractPage({ pageIndex: 0, includePathSegments });
  s.close();
  return model;
}

const text = (m: PageModel) => m.chars.map((c) => c.text).join('');
const seqs = (m: PageModel) => m.chars.map((c) => c.glyphSeq);
const show = (tr: number, body: string) => `BT /F1 12 Tf ${tr} Tr 10 150 Td ${body} ET`;

describe('extractPage: characters, coordinates, reading order', () => {
  const model = extract(
    `BT /F1 12 Tf 10 150 Td (Hello) Tj ET BT /F2 14 Tf 10 100 Td ${hexGlyphs('한글')} Tj ET`,
  );

  it('glyph numbers are consecutive from 0 and hold the character, gid, font and size', () => {
    expect(seqs(model)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(text(model)).toBe('Hello한글');
    expect(model.glyphCount).toBe(7);
    expect(model.paintCount).toBe(0);
    expect(model.fonts.map((f) => f.name)).toEqual(['Helvetica', 'NotoSansKR-Regular']);
    expect(model.chars.map((c) => c.fontId)).toEqual([0, 0, 0, 0, 0, 1, 1]);
    expect(model.chars[0]!.size).toBeCloseTo(12, 5);
    expect(model.chars[5]!.size).toBeCloseTo(14, 5);
    expect(model.chars[5]!.gid).toBeGreaterThan(0);
    expect(model.chars.every((c) => c.render === 'fill' && !c.clip && c.wmode === 0)).toBe(true);
  });

  it('the origin is in page space (top-left origin, y down) and the quad surrounds the baseline', () => {
    expect(model.bounds).toEqual([0, 0, 300, 200]);
    expect(model.userToPage).toEqual([1, 0, 0, -1, 0, 200]);
    const h = model.chars[0]!;
    expect(h.origin).toEqual([10, 50]);
    const [ulx, uly, urx, ury, llx, lly, lrx, lry] = h.quad;
    expect(ulx).toBeCloseTo(10, 3);
    expect(llx).toBeCloseTo(10, 3);
    expect(urx).toBeGreaterThan(ulx);
    expect(lrx).toBeCloseTo(urx, 3);
    expect(uly).toBeLessThan(50);
    expect(lly).toBeGreaterThan(50);
    expect(ury).toBeCloseTo(uly, 3);
    expect(lry).toBeCloseTo(lly, 3);
    // The origin of the next character is the right edge of the previous character.
    expect(model.chars[1]!.origin[0]).toBeCloseTo(urx, 2);
  });

  it('lines and blocks are in reading order and each refers to every character once', () => {
    expect(model.lines.map((l) => l.chars)).toEqual([
      [0, 1, 2, 3, 4],
      [5, 6],
    ]);
    expect(model.blocks.map((b) => b.lines)).toEqual([[0], [1]]);
    expect(model.lines.map((l) => l.block)).toEqual([0, 1]);
    expect(model.chars.map((c) => c.line)).toEqual([0, 0, 0, 0, 0, 1, 1]);
    expect(model.lines[0]!.dir).toEqual([1, 0]);
    expect(model.lines[0]!.wmode).toBe(0);
  });

  it('warnings and metrics: no approximation, extractMs recorded', () => {
    expect(model.warnings).toEqual([]);
    expect(model.extractMs).toBeGreaterThan(0);
  });

  it('/Rotate 90 page: bounds, transform and rotation are reflected, and the origin is in the transformed page space', () => {
    const m = extract({ content: 'BT /F1 12 Tf 10 150 Td (A) Tj ET', rotate: 90 });
    expect(m.bounds).toEqual([0, 0, 200, 300]);
    expect(m.userToPage).toEqual([0, 1, 1, 0, 0, 0]);
    expect(m.rotation).toBe(90);
    expect(m.chars[0]!.origin).toEqual([150, 10]);
    expect(m.chars[0]!.size).toBeCloseTo(12, 5);
    expect(m.lines[0]!.dir[1]).toBeCloseTo(1, 5);
  });

  it('even when the MediaBox is not at the origin, page space has a top-left origin', () => {
    const m = extract({
      content: 'BT /F1 12 Tf 110 250 Td (A) Tj ET',
      mediabox: [100, 100, 400, 300],
    });
    expect(m.bounds).toEqual([0, 0, 300, 200]);
    expect(m.chars[0]!.origin).toEqual([10, 50]);
  });
});

describe('extractPage: glyphSeq rules (Tr 0–7, contract 3.1 first-arrival counting)', () => {
  const cases: Array<[number, string, boolean, string]> = [
    [0, 'fill', false, 'AB'],
    [1, 'stroke', false, 'AB'],
    [2, 'fill-stroke', false, 'AB'],
    [3, 'invisible', false, 'AB'],
    [4, 'fill', true, 'AB'],
    [5, 'stroke', true, 'AB'],
    [6, 'fill-stroke', true, 'AB'],
    [7, 'invisible', true, 'AB'],
  ];
  for (const [tr, render, clip, expected] of cases) {
    it(`Tr ${tr}: counts the glyph exactly once (render ${render}, clip ${clip})`, () => {
      const m = extract(show(tr, '(AB) Tj'));
      expect(text(m)).toBe(expected);
      expect(seqs(m)).toEqual([0, 1]);
      expect(m.glyphCount).toBe(2);
      expect(m.chars.map((c) => [c.render, c.clip])).toEqual([
        [render, clip],
        [render, clip],
      ]);
      expect(m.warnings).toEqual([]);
    });
  }

  it('Tr 3 (invisible) is counted. The color is null', () => {
    const m = extract(show(3, '(AB) Tj'));
    expect(m.chars.map((c) => c.color)).toEqual([null, null]);
    expect(m.chars.every((c) => c.line === 0)).toBe(true);
  });

  it('Tr 7: counted first in the clip callback (invisible, clip true, color null). It is combined with the structured text', () => {
    const s = open([show(7, '(AB) Tj')]);
    const page = s.document.loadPage(0);
    const { model, stats } = extractPageDetailed(page, { pageIndex: 0 });
    page.destroy();
    expect(text(model)).toBe('AB');
    expect(model.chars.map((c) => [c.render, c.clip, c.color, c.line])).toEqual([
      ['invisible', true, null, 0],
      ['invisible', true, null, 0],
    ]);
    expect(stats).toMatchObject({ clipCounted: 2, retransmitted: 0, approximated: 0 });
    expect(model.warnings).toEqual([]);
    s.close();
  });

  it('Tr 4–6: consume the ET resend without counting it and record it in stats', () => {
    const s = open([show(6, '(AB) Tj')]);
    const page = s.document.loadPage(0);
    const { stats } = extractPageDetailed(page, { pageIndex: 0 });
    page.destroy();
    expect(stats).toMatchObject({ glyphs: 2, retransmitted: 2, clipCounted: 0 });
    s.close();
  });

  it('in Tr 6, even if a color change splits the fill (the clip arrives merged into one), each glyph is counted once', () => {
    const m = extract(show(6, '1 0 0 rg (AB) Tj 0 1 0 rg (CD) Tj'));
    expect(text(m)).toBe('ABCD');
    expect(seqs(m)).toEqual([0, 1, 2, 3]);
    expect(m.chars.every((c) => c.render === 'fill-stroke' && c.clip)).toBe(true);
    // fill color (first two characters red, last two green)
    expect(m.chars.map((c) => c.color)).toEqual([
      [1, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 1, 0],
    ]);
  });

  it('two Tr 4 BTs: the clip of each BT is marked only on its own glyphs', () => {
    const m = extract(
      `BT /F1 12 Tf 4 Tr 10 150 Td (AB) Tj ET BT /F1 12 Tf 0 Tr 10 100 Td (CD) Tj ET BT /F1 12 Tf 4 Tr 10 50 Td (EF) Tj ET`,
    );
    expect(text(m)).toBe('ABCDEF');
    expect(m.chars.map((c) => c.clip)).toEqual([true, true, false, false, true, true]);
  });

  it('when Tr 0 and 7 are mixed, only the Tr 7 glyphs drop out and the numbers stay consecutive', () => {
    const m = extract(`BT /F1 12 Tf 10 150 Td (AB) Tj 7 Tr (CD) Tj 0 Tr (EF) Tj ET`);
    expect(text(m)).toBe('ABEF');
    expect(seqs(m)).toEqual([0, 1, 2, 3]);
  });

  it('a duplicate structured-text line from Tr 4 does not enter lines or blocks', () => {
    const m = extract(show(4, '(AB) Tj'));
    expect(m.lines).toHaveLength(1);
    expect(m.lines[0]!.chars).toEqual([0, 1]);
    expect(m.blocks).toHaveLength(1);
  });

  it('glyphs drawn on top of each other at the same position (fake bold) are each counted', () => {
    const m = extract(`BT /F1 12 Tf 10 150 Td (AB) Tj ET BT /F1 12 Tf 10 150 Td (AB) Tj ET`);
    expect(text(m)).toBe('ABAB');
    expect(seqs(m)).toEqual([0, 1, 2, 3]);
  });

  it('glyphs inside a Form XObject are counted in execution order at the Do position', () => {
    const m = extract({
      content:
        'BT /F1 12 Tf 10 150 Td (A) Tj ET q 1 0 0 1 50 50 cm /Fm1 Do Q BT /F1 12 Tf 10 20 Td (Z) Tj ET',
      resources: (doc, res) => {
        const font = (res.Font as Record<string, unknown>).F1;
        res.XObject = {
          Fm1: doc.addStream('BT /F1 10 Tf 5 5 Td (XY) Tj ET', {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 100, 100],
            Resources: { Font: { F1: font } },
          }),
        };
      },
    });
    expect(text(m)).toBe('AXYZ');
    expect(seqs(m)).toEqual([0, 1, 2, 3]);
    // The BBox clip of the Form uses 1 paintSeq.
    expect(m.paths.map((p) => [p.paintSeq, p.op])).toEqual([[0, 'clip']]);
    expect(m.chars[1]!.origin).toEqual([55, 145]);
  });
});

describe('extractPage: vertical writing (wmode 1) structured text combination', () => {
  /** /FV: the same Hangul font as F2 with Identity-V. */
  const vertical = (content: string): PageSpec => ({
    content,
    mediabox: [0, 0, 300, 300],
    resources: (doc, resources) => {
      const ref = doc.addFont(koreanFont);
      ref.put('Encoding', doc.newName('Identity-V'));
      (resources.Font as Record<string, unknown>).FV = ref;
    },
  });

  it.each([
    ['기본', 'BT /FV 20 Tf 150 280 Td GLYPHS Tj ET'],
    ['회전·Tc', 'BT /FV 10 Tf 3 Tc 0.7071 0.7071 -0.7071 0.7071 150 280 Tm GLYPHS Tj ET'],
  ])(
    '%s: each character gets the quad of its own glyph (not the quad of the previous glyph), no approximation',
    (_, body) => {
      const word = '한글세로쓰기';
      const s = open([vertical(body.replace('GLYPHS', hexGlyphs(word)))]);
      const page = s.document.loadPage(0);
      const { model, stats } = extractPageDetailed(page, { pageIndex: 0 });
      // Quads of the structured text characters (they come in the same order).
      const stext: { c: string; quad: number[] }[] = [];
      const st = page.toStructuredText('');
      st.walk({ onChar: (c, _o, _f, _s, quad) => stext.push({ c, quad: [...quad] }) });
      st.destroy();
      page.destroy();
      s.close();
      expect(text(model)).toBe(word);
      expect(stext.map((x) => x.c).join('')).toBe(word);
      expect(model.chars.every((c) => c.wmode === 1)).toBe(true);
      expect(stats.approximated).toBe(0);
      expect(model.chars.every((c) => c.line >= 0)).toBe(true);
      // Character i gets the quad of structured text character i (earlier defect: the quad of the previous glyph, with the first character approximated).
      model.chars.forEach((c, i) => {
        c.quad.forEach((v, k) => expect(v, `${i}.${k}`).toBeCloseTo(stext[i]!.quad[k]!, 3));
      });
    },
  );
});

describe('extractPage: characters absent from the structured text (quad approximation)', () => {
  it('characters outside the page get an approximated quad, line -1, and a warning', () => {
    const s = open(['BT /F1 12 Tf 10 150 Td (AB) Tj ET BT /F1 12 Tf 350 150 Td (XY) Tj ET']);
    const page = s.document.loadPage(0);
    const { model, stats } = extractPageDetailed(page, { pageIndex: 0 });
    page.destroy();
    expect(text(model)).toBe('ABXY');
    expect(model.chars.map((c) => c.line)).toEqual([0, 0, -1, -1]);
    expect(stats).toMatchObject({ glyphs: 4, matched: 2, approximated: 2 });
    expect(model.warnings).toEqual([
      '구조화 텍스트에 없는 글자 2개: quad 근사, line -1 (glyphSeq 2, 3)',
    ]);
    const x = model.chars[2]!;
    expect(x.origin).toEqual([350, 50]);
    const [ulx, uly, urx, ury, llx, lly, lrx, lry] = x.quad;
    expect(ulx).toBeCloseTo(350, 3);
    expect(llx).toBeCloseTo(350, 3);
    // to the right by advance, above and below proportional to the glyph size
    expect(urx).toBeGreaterThan(350);
    expect(lrx).toBeCloseTo(urx, 3);
    expect(uly).toBeLessThan(50);
    expect(lly).toBeGreaterThan(50);
    expect(ury).toBeCloseTo(uly, 3);
    expect(lry).toBeCloseTo(lly, 3);
    expect(uly).toBeCloseTo(50 - 0.95 * 12, 3);
    expect(lly).toBeCloseTo(50 + 0.25 * 12, 3);
    // Approximated characters do not enter lines.
    expect(model.lines.flatMap((l) => l.chars)).toEqual([0, 1]);
    s.close();
  });

  it('a synthetic space is counted as an unpaired structured text character (not put into characters or lines)', () => {
    const s = open(['BT /F1 12 Tf 10 150 Td [(A) -300 (B)] TJ ET']);
    const page = s.document.loadPage(0);
    const { model, stats } = extractPageDetailed(page, { pageIndex: 0 });
    page.destroy();
    expect(text(model)).toBe('AB');
    expect(model.lines[0]!.chars).toEqual([0, 1]);
    expect(stats.stextOnlySpaces).toBe(1);
    expect(model.warnings).toEqual([]);
    s.close();
  });
});

/** Tiling pattern P1 resource (a rectangle and the character 't' in the cell). */
function patternResources(doc: mupdf.PDFDocument, res: Record<string, unknown>): void {
  const font = (res.Font as Record<string, unknown>).F1;
  res.Pattern = {
    P1: doc.addStream('1 0 0 rg 0 0 5 5 re f BT /F1 4 Tf 0 0 Td (t) Tj ET', {
      Type: 'Pattern',
      PatternType: 1,
      PaintType: 1,
      TilingType: 1,
      BBox: [0, 0, 10, 10],
      XStep: 10,
      YStep: 10,
      Resources: { Font: { F1: font } },
    }),
  };
}

/** Soft mask GsM resource (a rectangle and the character 'M' in the mask group). */
function softMaskResources(doc: mupdf.PDFDocument, res: Record<string, unknown>): void {
  const font = (res.Font as Record<string, unknown>).F1;
  const group = doc.addStream('0.5 g 0 0 100 100 re f BT /F1 10 Tf 5 5 Td (M) Tj ET', {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, 100, 100],
    Group: { S: 'Transparency', CS: 'DeviceGray' },
    Resources: { Font: { F1: font } },
  });
  res.ExtGState = { GsM: { SMask: { Type: 'Mask', S: 'Luminosity', G: group } } };
}

describe('extractPage: exclude callbacks outside the page content (pattern cell, soft mask)', () => {
  it('tiling pattern cell content is not counted (a shape painted with the pattern is 1 clip)', () => {
    const m = extract({
      content: '/Pattern cs /P1 scn 120 120 60 60 re f',
      resources: patternResources,
    });
    expect(m.glyphCount).toBe(0);
    expect(m.paths.map((p) => [p.paintSeq, p.op])).toEqual([[0, 'clip']]);
    expect(m.paintCount).toBe(1);
  });

  it('shapes and characters inside a soft mask group are not counted', () => {
    const m = extract({
      content: 'q /GsM gs 0 0 1 rg 0 0 100 100 re f Q BT /F1 12 Tf 10 150 Td (after) Tj ET',
      resources: softMaskResources,
    });
    expect(text(m)).toBe('after');
    expect(seqs(m)).toEqual([0, 1, 2, 3, 4]);
    expect(m.paths.map((p) => [p.paintSeq, p.op, p.color?.rgb])).toEqual([[0, 'fill', [0, 0, 1]]]);
    expect(m.paintCount).toBe(1);
  });
});

describe('extractPage: clip text first-arrival counting (contract 3.1 notation table)', () => {
  const run = (content: string | PageSpec) => {
    const s = open([content]);
    const page = s.document.loadPage(0);
    const result = extractPageDetailed(page, { pageIndex: 0 });
    page.destroy();
    s.close();
    return result;
  };
  const shadingResources = (_doc: mupdf.PDFDocument, res: Record<string, unknown>) => {
    const shading = {
      ShadingType: 2,
      ColorSpace: 'DeviceRGB',
      Coords: [0, 0, 100, 0],
      Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 },
      Extend: [true, true],
    };
    res.Shading = { Sh1: shading };
    res.Pattern = { P2: { PatternType: 2, Shading: shading } };
  };

  it('tiling pattern color text: counted first in the clip callback, and when beginTile arrives: fill, clip false, color null', () => {
    const { model, stats } = run({
      content: '/Pattern cs /P1 scn BT /F1 12 Tf 10 150 Td (after) Tj ET',
      resources: patternResources,
    });
    expect(text(model)).toBe('after');
    expect(seqs(model)).toEqual([0, 1, 2, 3, 4]);
    expect(model.chars.every((c) => c.render === 'fill' && !c.clip && c.color === null)).toBe(true);
    expect(model.chars.every((c) => c.line === 0)).toBe(true);
    expect(stats).toMatchObject({ clipCounted: 5, retransmitted: 0, approximated: 0 });
    expect(model.paintCount).toBe(0);
  });

  it('shading pattern color text: when fillShade arrives: fill, clip false, and the shade has paintSeq 0', () => {
    const { model } = run({
      content: '/Pattern cs /P2 scn BT /F1 12 Tf 10 150 Td (grad) Tj ET',
      resources: shadingResources,
    });
    expect(text(model)).toBe('grad');
    expect(model.chars.every((c) => c.render === 'fill' && !c.clip && c.color === null)).toBe(true);
    expect(model.shades.map((x) => x.paintSeq)).toEqual([0]);
  });

  it('sh after clipping with Tr 7: the shade arrives before the popClip of the same clip, so it is treated as pattern color text', () => {
    const { model } = run({
      content: 'q BT /F1 24 Tf 7 Tr 10 100 Td (AB) Tj ET /Sh1 sh Q',
      resources: shadingResources,
    });
    expect(text(model)).toBe('AB');
    expect(model.chars.every((c) => c.render === 'fill' && !c.clip)).toBe(true);
    expect(model.shades).toHaveLength(1);
  });

  // Contract amendment 6: text callbacks with the same pointer are skipped regardless of kind (reproduces pdf-ops).
  it('Tr 6 with both fill and stroke in pattern color: skips the same object of clip→clipStroke and consumes the ET resend', () => {
    const { model, stats } = run({
      content:
        '/Pattern cs /P2 scn /Pattern CS /P2 SCN BT /F1 20 Tf 50 150 Td 6 Tr (Ef) Tj ET 0 Tr ' +
        '0 g /Pattern CS /P2 SCN BT /F1 20 Tf 50 100 Td 6 Tr (Gh) Tj ET 0 Tr',
      resources: shadingResources,
    });
    // 4 shown glyphs. Without skipping, clipStroke would empty the list and count 4 more ET resends (8).
    expect(text(model)).toBe('EfGh');
    expect(seqs(model)).toEqual([0, 1, 2, 3]);
    expect(stats).toMatchObject({ clipCounted: 2, retransmitted: 4, clipDepth: 0 });
    // Shading pattern painting: Ef is fill and stroke twice, Gh is stroke only
    expect(model.shades).toHaveLength(3);
  });

  it('fill color + stroke pattern Tr 6: skips the same object of fill→clipStroke', () => {
    const { model, stats } = run({
      content: '0 g /Pattern CS /P2 SCN BT /F1 20 Tf 50 150 Td 6 Tr (Ab) Tj ET 0 Tr',
      resources: shadingResources,
    });
    expect(text(model)).toBe('Ab');
    expect(stats).toMatchObject({ glyphs: 2, retransmitted: 2, clipDepth: 0 });
    expect(model.chars.map((c) => [c.render, c.clip])).toEqual([
      ['fill', true],
      ['fill', true],
    ]);
  });

  it('a skipped clip callback is also pushed on the clip stack so that popClip pairs up (balanced)', () => {
    const { stats } = run({
      content:
        '/Pattern cs /P2 scn /Pattern CS /P2 SCN BT /F1 20 Tf 50 150 Td 6 Tr (Ef) Tj ET 0 Tr ' +
        'q 10 10 80 80 re W n /Sh1 sh Q',
      resources: shadingResources,
    });
    expect(stats.clipDepth).toBe(0);
  });

  it('when Tr 4 and Tr 7 are mixed in one BT, only the Tr 7 glyphs are newly counted (numbers follow display order)', () => {
    const { model, stats } = run(show(4, '(AB) Tj 7 Tr (CD) Tj'));
    expect(text(model)).toBe('ABCD');
    expect(seqs(model)).toEqual([0, 1, 2, 3]);
    expect(model.chars.map((c) => [c.render, c.clip])).toEqual([
      ['fill', true],
      ['fill', true],
      ['invisible', true],
      ['invisible', true],
    ]);
    expect(stats).toMatchObject({ retransmitted: 2, clipCounted: 2 });
  });

  // Cases from the measured table in pdf-ops `docs/m1-pdf-ops.md` 3.1 (numbers are assigned in first-arrival order).
  it('pdf-ops table: `7 Tr (A) 4 Tr (B)` → B first (display time), A is newly counted in the ET resend', () => {
    const { model } = run(show(7, '(A) Tj 4 Tr (B) Tj'));
    expect(text(model)).toBe('BA');
    expect(seqs(model)).toEqual([0, 1]);
    expect(model.chars.map((c) => [c.render, c.clip])).toEqual([
      ['fill', true], // B: Tr 4, consumes the resend
      ['invisible', true], // A: Tr 7, counted first in the clip callback
    ]);
  });

  it('pdf-ops table: `4 Tr (Ab) 0 Tr (Xy) 7 Tr (Cd) 3 Tr (In)` → 8 glyphs, in the order Ab, Xy, In, Cd', () => {
    const { model, stats } = run(show(4, '(Ab) Tj 0 Tr (Xy) Tj 7 Tr (Cd) Tj 3 Tr (In) Tj'));
    expect(text(model)).toBe('AbXyInCd');
    expect(seqs(model)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(model.chars.map((c) => [c.render, c.clip])).toEqual([
      ['fill', true],
      ['fill', true], // Ab: Tr 4, consumes the ignoreText resend
      ['fill', false],
      ['fill', false], // Xy: Tr 0
      ['invisible', false],
      ['invisible', false], // In: Tr 3, counted first in ignoreText
      ['invisible', false],
      ['invisible', false], // Cd: Tr 7 is counted first in a resend of the ignoreText form (indistinguishable from Tr 3)
    ]);
    expect(stats).toMatchObject({ retransmitted: 2, clipCounted: 0 });
  });

  it('pdf-ops table: `7 Tr (A) 0 Tr (B)` → B only (A never reaches the Device)', () => {
    const { model } = run(show(7, '(A) Tj 0 Tr (B) Tj'));
    expect(text(model)).toBe('B');
  });

  it('pdf-ops table: `4 Tr (A) 1 Tr (B)` → A and B 1 each (A has no clip)', () => {
    const { model } = run(show(4, '(A) Tj 1 Tr (B) Tj'));
    expect(text(model)).toBe('AB');
    expect(model.chars.map((c) => [c.render, c.clip])).toEqual([
      ['fill', false],
      ['stroke', false],
    ]);
  });

  it('when the last glyph of a BT is Tr 0, the preceding Tr 7 glyphs never reach the Device', () => {
    const { model } = run(show(0, '(AB) Tj 7 Tr (CD) Tj 0 Tr (EF) Tj'));
    expect(text(model)).toBe('ABEF');
  });

  it('known limitation: drawing a normal character at the same position and then the same character with Tr 7 in another BT is misjudged as a resend', () => {
    const { model, stats } = run(`${show(0, '(AB) Tj')} 0 0 5 5 re f ${show(7, '(AB) Tj')}`);
    expect(text(model)).toBe('AB');
    expect(stats.retransmitted).toBe(2);
    expect(model.chars.every((c) => c.clip)).toBe(true);
  });

  // Drawing the same Form at two positions gives the same glyph trm and only a different callback ctm (contract amendment 4).
  const formA: Pick<PageSpec, 'resources'> = {
    resources: (doc, res) => {
      const font = (res.Font as Record<string, unknown>).F1;
      res.XObject = {
        Fm1: doc.addStream('BT /F1 12 Tf 5 5 Td (A) Tj ET', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 100, 100],
          Resources: { Font: { F1: font } },
        }),
      };
    },
  };
  const twoForms = 'q 1 0 0 1 10 10 cm /Fm1 Do Q q 1 0 0 1 10 100 cm /Fm1 Do Q';

  it('after drawing the same Form at two positions, writing a character with the same trm at a third position with Tr 7 is counted as a new character', () => {
    const { model, stats } = run({
      content: `${twoForms} q 1 0 0 1 100 150 cm BT /F1 12 Tf 7 Tr 5 5 Td (A) Tj ET Q`,
      ...formA,
    });
    expect(text(model)).toBe('AAA');
    expect(seqs(model)).toEqual([0, 1, 2]);
    expect(stats.retransmitted).toBe(0);
    expect(model.chars.map((c) => [c.render, c.clip])).toEqual([
      ['fill', false],
      ['fill', false],
      ['invisible', true],
    ]);
  });

  it('writing again with Tr 7 at the same position (both trm and ctm equal) is treated as a resend (known limitation)', () => {
    const { model, stats } = run({
      content: `${twoForms} q 1 0 0 1 10 100 cm BT /F1 12 Tf 7 Tr 5 5 Td (A) Tj ET Q`,
      ...formA,
    });
    expect(text(model)).toBe('AA');
    expect(stats.retransmitted).toBe(1);
    // Consumption is one item at a time, so the clip is attached only to the glyphs of the second Form instance (same position).
    expect(model.chars.map((c) => c.clip)).toEqual([false, true]);
  });

  it('the same character at a different position is not a resend', () => {
    const { model } = run(
      'BT /F1 12 Tf 10 150 Td (AB) Tj ET BT /F1 12 Tf 7 Tr 10 100 Td (AB) Tj ET',
    );
    expect(text(model)).toBe('ABAB');
    expect(seqs(model)).toEqual([0, 1, 2, 3]);
  });
});

const near = (
  actual: readonly number[] | null | undefined,
  expected: readonly number[],
  eps = 0.01,
) => {
  expect(actual).not.toBeNull();
  expect(actual!.length).toBe(expected.length);
  actual!.forEach((v, i) => expect(Math.abs(v - expected[i]!)).toBeLessThanOrEqual(eps));
};

describe('extractPage: color spaces', () => {
  const colorSpaces = (doc: mupdf.PDFDocument, res: Record<string, unknown>) => {
    res.ColorSpace = {
      Sep: [
        'Separation',
        'Spot',
        'DeviceRGB',
        { FunctionType: 2, Domain: [0, 1], C0: [1, 1, 1], C1: [1, 0, 0], N: 1 },
      ],
      Lab: ['Lab', { WhitePoint: [0.9505, 1, 1.089], Range: [-128, 127, -128, 127] }],
      Idx: ['Indexed', 'DeviceRGB', 1, doc.newByteString(new Uint8Array([255, 0, 0, 0, 255, 0]))],
    };
  };
  const model = extract({
    content: [
      '0.2 0.4 0.6 rg 0 0 10 10 re f',
      '0.5 g 20 0 10 10 re f',
      '0.2 0.4 0.6 0.1 k 40 0 10 10 re f',
      '/Sep cs 0.7 sc 60 0 10 10 re f',
      '/Lab cs 50 40 -30 sc 80 0 10 10 re f',
      '/Idx cs 1 sc 100 0 10 10 re f',
      '1 0 0 RG 0 0 1 rg BT /F1 12 Tf 1 Tr 10 150 Td (K) Tj ET',
    ].join('\n'),
    resources: colorSpaces,
  });
  const paint = (i: number) => model.paths[i]!.color!;

  it('DeviceRGB and DeviceGray: sRGB equal to the original values', () => {
    expect(paint(0)).toEqual({
      space: 'DeviceRGB',
      values: expect.any(Array),
      rgb: expect.any(Array),
    });
    near(paint(0).values, [0.2, 0.4, 0.6]);
    near(paint(0).rgb, [0.2, 0.4, 0.6]);
    expect(paint(1).space).toBe('DeviceGray');
    near(paint(1).values, [0.5]);
    near(paint(1).rgb, [0.5, 0.5, 0.5]);
  });

  it('DeviceCMYK: the original CMYK values and the MuPDF-converted sRGB (same value as the render result)', () => {
    expect(paint(2).space).toBe('DeviceCMYK');
    near(paint(2).values, [0.2, 0.4, 0.6, 0.1]);
    near(paint(2).rgb, [186 / 255, 143 / 255, 104 / 255], 1 / 255);
  });

  it('Separation, Lab and Indexed: the original color space values and an sRGB approximation', () => {
    expect(paint(3).space).toBe('Separation(DeviceRGB,Spot)');
    near(paint(3).values, [0.7]);
    near(paint(3).rgb, [1, 76 / 255, 76 / 255], 1 / 255);
    expect(paint(4).space).toBe('Lab');
    near(paint(4).values, [50, 40, -30]);
    near(paint(4).rgb, [165 / 255, 91 / 255, 171 / 255], 2 / 255);
    // Indexed takes the index (integer) as the value, and sRGB is the palette entry.
    expect(paint(5).space).toBe('Indexed(1,DeviceRGB)');
    expect(paint(5).values).toEqual([1]);
    near(paint(5).rgb, [0, 1, 0], 1 / 255);
  });

  it('the color of stroke-only text (Tr 1) is the stroke color', () => {
    expect(model.chars[0]!.render).toBe('stroke');
    near(model.chars[0]!.color, [1, 0, 0], 1 / 255);
  });
});

describe('extractPage: shapes', () => {
  const content = [
    '0 0 1 rg 1 0 0 RG 3 w',
    '10 10 50 20 re B', // fill + stroke: 2 callbacks
    '100 100 m 150 100 l 150 150 l h f*', // even-odd fill
    '200 20 m 220 20 240 40 260 40 c S', // curved stroke
    '0 0 20 20 re W n', // clip
  ].join('\n');

  it('fill + stroke (B) uses 2 paintSeq (fill → stroke), and numbers are consecutive from 0', () => {
    const m = extract(content);
    expect(m.paths.map((p) => [p.paintSeq, p.op, p.evenOdd])).toEqual([
      [0, 'fill', false],
      [1, 'stroke', false],
      [2, 'fill', true],
      [3, 'stroke', false],
      [4, 'clip', false],
    ]);
    expect(m.paintCount).toBe(5);
    expect(m.paths.length + m.images.length + m.shades.length).toBe(m.paintCount);
  });

  it('bounds, transform, line width, color', () => {
    const m = extract(content);
    const [fill, stroke, evenOdd, curve, clip] = m.paths as [
      PageModel['paths'][number],
      PageModel['paths'][number],
      PageModel['paths'][number],
      PageModel['paths'][number],
      PageModel['paths'][number],
    ];
    expect(fill.ctm).toEqual([1, 0, 0, -1, 0, 200]);
    // User space (10,10)–(60,30) → page space (10,170)–(60,190)
    near(fill.bbox, [10, 170, 60, 190]);
    expect(fill.lineWidth).toBeNull();
    expect(fill.alpha).toBe(1);
    near(fill.color!.rgb, [0, 0, 1]);
    // Bounds including line width 3
    near(stroke.bbox, [8.5, 168.5, 61.5, 191.5]);
    expect(stroke.lineWidth).toBe(3);
    near(stroke.color!.rgb, [1, 0, 0]);
    near(evenOdd.bbox, [100, 50, 150, 100]);
    // The bounds of an open stroke are widened by MuPDF to include join and cap margins (miter limit). It is enough to include the curve points
    // (200,180)–(260,160).
    expect(curve.bbox[0]).toBeLessThanOrEqual(200);
    expect(curve.bbox[2]).toBeGreaterThanOrEqual(260);
    expect(curve.bbox[1]).toBeLessThanOrEqual(160);
    expect(curve.bbox[3]).toBeGreaterThanOrEqual(180);
    expect(clip.color).toBeNull();
    expect(clip.lineWidth).toBeNull();
    near(clip.bbox, [0, 180, 20, 200]);
  });

  it('includePathSegments: holds path-space segments only when requested', () => {
    const without = extract(content);
    expect(without.paths.every((p) => p.segments === null)).toBe(true);
    const withSegments = extract(content, true);
    expect(withSegments.paths[0]!.segments).toEqual([
      { type: 'M', p: [10, 10] },
      { type: 'L', p: [60, 10] },
      { type: 'L', p: [60, 30] },
      { type: 'L', p: [10, 30] },
      { type: 'Z' },
    ]);
    expect(withSegments.paths[2]!.segments).toEqual([
      { type: 'M', p: [100, 100] },
      { type: 'L', p: [150, 100] },
      { type: 'L', p: [150, 150] },
      { type: 'Z' },
    ]);
    expect(withSegments.paths[3]!.segments).toEqual([
      { type: 'M', p: [200, 20] },
      { type: 'C', p1: [220, 20], p2: [240, 40], p3: [260, 40] },
    ]);
  });

  it('opacity (gs ca, CA) is stored as alpha', () => {
    const m = extract({
      content: '/Gs1 gs 1 0 0 rg 0 0 1 RG 0 0 50 50 re B',
      resources: (_doc, res) => {
        res.ExtGState = { Gs1: { CA: 0.5, ca: 0.25 } };
      },
    });
    expect(m.paths.map((p) => p.alpha)).toEqual([0.25, 0.5]);
  });

  it('q/Q clip: popClip uses no number', () => {
    const m = extract('q 0 0 50 50 re W n 10 10 20 20 re f Q 100 100 10 10 re f');
    expect(m.paths.map((p) => [p.paintSeq, p.op])).toEqual([
      [0, 'clip'],
      [1, 'fill'],
      [2, 'fill'],
    ]);
  });
});

describe('extractPage: images and shades', () => {
  const withImagesAndShade = (doc: mupdf.PDFDocument, res: Record<string, unknown>) => {
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 4, 3], false);
    pixmap.clear(200);
    res.XObject = { Im1: doc.addImage(new mupdf.Image(pixmap)) };
    res.Shading = {
      Sh1: {
        ShadingType: 2,
        ColorSpace: 'DeviceRGB',
        Coords: [0, 0, 100, 0],
        Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 },
        Extend: [true, true],
      },
    };
    res.ExtGState = { Gs1: { ca: 0.5 } };
  };
  const content = [
    'q 100 0 0 50 20 30 cm /Im1 Do Q',
    'q 10 10 80 80 re W n /Sh1 sh Q',
    'q /Gs1 gs BI /W 2 /H 2 /CS /G /BPC 8 ID abcd EI Q',
    'q 30 0 0 30 150 100 cm BI /W 8 /H 8 /IM true /BPC 1 ID 12345678 EI Q',
  ].join('\n');
  const model = extract({ content, resources: withImagesAndShade });

  it('image: pixel size, page-space bounds and transform, including inline images and image masks', () => {
    expect(model.images.map((i) => [i.paintSeq, i.op, i.width, i.height])).toEqual([
      [0, 'image', 4, 3],
      [3, 'image', 2, 2],
      [4, 'image-mask', 8, 8],
    ]);
    // XObject: user space (20,30)–(120,80) → page space (20,120)–(120,170)
    near(model.images[0]!.bbox, [20, 120, 120, 170]);
    near(model.images[0]!.ctm, [100, 0, 0, 50, 20, 120]);
    expect(model.images[0]!.alpha).toBe(1);
    expect(model.images[1]!.alpha).toBe(0.5);
    near(model.images[2]!.bbox, [150, 70, 180, 100]);
  });

  it('shade: an infinite bound is folded into the current clip bounds', () => {
    expect(model.shades).toHaveLength(1);
    expect(model.shades[0]!.paintSeq).toBe(2);
    near(model.shades[0]!.bbox, [10, 110, 90, 190]);
    expect(model.shades[0]!.alpha).toBe(1);
  });

  it('paintSeq is consecutive from 0 without overlap across images, clips and shades', () => {
    const all = [...model.paths, ...model.images, ...model.shades]
      .map((x) => x.paintSeq)
      .sort((a, b) => a - b);
    expect(all).toEqual([0, 1, 2, 3, 4]);
    expect(model.paintCount).toBe(5);
    expect(model.paths.map((p) => [p.paintSeq, p.op])).toEqual([[1, 'clip']]);
  });
});

describe('extractPage: shape painted with a shading pattern', () => {
  it('MuPDF sends it as clipPath + fillShade (2 numbers)', () => {
    const m = extract({
      content: '/Pattern cs /P2 scn 10 10 80 80 re f',
      resources: (doc, res) => {
        res.Pattern = {
          P2: {
            PatternType: 2,
            Shading: {
              ShadingType: 2,
              ColorSpace: 'DeviceRGB',
              Coords: [0, 0, 100, 0],
              Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 },
              Extend: [true, true],
            },
          },
        };
        void doc;
      },
    });
    expect(m.paths.map((p) => [p.paintSeq, p.op])).toEqual([[0, 'clip']]);
    expect(m.shades.map((s) => s.paintSeq)).toEqual([1]);
    expect(m.paintCount).toBe(2);
  });
});

describe('extractPage: annotations excluded, warnings, cache', () => {
  it('annotation text does not enter the extraction model', () => {
    const s = new PdfSession();
    const doc = new mupdf.PDFDocument();
    const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
    doc.insertPage(
      -1,
      doc.addPage(
        [0, 0, 300, 200],
        0,
        { Font: { F1: font } },
        'BT /F1 12 Tf 10 150 Td (body) Tj ET',
      ),
    );
    const page = doc.loadPage(0);
    const annot = page.createAnnotation('FreeText');
    annot.setRect([100, 20, 250, 60]);
    annot.setContents('ANNOTATION');
    annot.update();
    expect(page.getAnnotations()).toHaveLength(1);
    page.destroy();
    s.open(doc.saveToBuffer('').asUint8Array().slice());
    const m = s.extractPage({ pageIndex: 0 });
    expect(text(m)).toBe('body');
    s.close();
  });

  it('puts MuPDF warnings into warnings and releases the log callback when done', () => {
    const m = extract('/NoSuchCS cs 0.5 sc 0 0 10 10 re f');
    expect(m.warnings.length).toBeGreaterThan(0);
    expect(m.warnings.every((w) => w.startsWith('MuPDF: '))).toBe(true);
    // A normal document has no warnings (warnings from the previous page do not linger).
    expect(extract('0 0 10 10 re f').warnings).toEqual([]);
  });

  it('per-page cache: the same request gives the same object, includePathSegments is a separate entry, and invalidation rebuilds it', () => {
    const s = open(['0 0 10 10 re f', 'BT /F1 12 Tf 10 150 Td (p2) Tj ET']);
    const a = s.extractPage({ pageIndex: 0 });
    expect(s.extractPage({ pageIndex: 0 })).toBe(a);
    const withSegments = s.extractPage({ pageIndex: 0, includePathSegments: true });
    expect(withSegments).not.toBe(a);
    expect(withSegments.paths[0]!.segments).not.toBeNull();
    expect(a.paths[0]!.segments).toBeNull();
    const b = s.extractPage({ pageIndex: 1 });
    s.invalidatePageCache(0);
    expect(s.extractPage({ pageIndex: 1 })).toBe(b);
    const a2 = s.extractPage({ pageIndex: 0 });
    expect(a2).not.toBe(a);
    expect(a2.paths).toEqual(a.paths);
    s.invalidatePageCache();
    expect(s.extractPage({ pageIndex: 1 })).not.toBe(b);
    s.close();
  });

  it('the cache keeps up to 16 pages in most-recently-used order', () => {
    const s = open(Array.from({ length: 18 }, (_, i) => `BT /F1 12 Tf 10 150 Td (${i}) Tj ET`));
    const first = s.extractPage({ pageIndex: 0 });
    for (let i = 1; i <= 16; i++) s.extractPage({ pageIndex: i });
    // Page 0 was evicted by the 17th entry.
    expect(s.extractPage({ pageIndex: 0 })).not.toBe(first);
    s.close();
  });
});

describe('extractPage: ligatures', () => {
  const DEJAVU = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  it('glyphText: ligature code points are expanded with NFKC', async () => {
    const { glyphText } = await import('../src/extract-stext.js');
    expect(glyphText(0xfb01)).toBe('fi');
    expect(glyphText(0xfb03)).toBe('ffi');
    expect(glyphText(0x41)).toBe('A');
    expect(glyphText(0x1f600)).toBe('😀');
    expect(glyphText(0)).toBe('�');
    expect(glyphText(-1)).toBe('�');
    expect(glyphText(0xd800)).toBe('�');
  });

  /** Extracts one page with a ToUnicode that maps code A of F2 to "fi" (two code points) and B to "B". */
  const extractMultiChar = (tr: number, glyphs: string) =>
    extract({
      content: `BT /F2 14 Tf ${tr} Tr 10 150 Td ${hexGlyphs(glyphs)} Tj ET`,
      resources: (doc, res) => {
        const gid = (c: string) => koreanFont.encodeCharacter(c).toString(16).padStart(4, '0');
        const font = (res.Font as Record<string, mupdf.PDFObject>).F2!;
        font.put(
          'ToUnicode',
          doc.addStream(
            [
              '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
              '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
              '/CMapName /Adobe-Identity-UCS def /CMapType 2 def',
              '1 begincodespacerange <0000> <FFFF> endcodespacerange',
              `2 beginbfchar <${gid('A')}> <00660069> <${gid('B')}> <0042> endbfchar`,
              'endcmap CMapName currentdict /CMap defineresource pop end end',
            ].join('\n'),
            {},
          ),
        );
      },
    });

  it('when ToUnicode maps one glyph to several characters, the glyph is counted once and the characters are gathered in text', () => {
    // MuPDF sends such a glyph as one gid entry + entries for the remaining characters with gid -1 (width 0) (contract 3.1 step 0).
    const m = extractMultiChar(0, 'ABA');
    expect(m.glyphCount).toBe(3);
    expect(m.chars.map((c) => c.text)).toEqual(['fi', 'B', 'fi']);
    expect(seqs(m)).toEqual([0, 1, 2]);
    expect(m.chars.every((c) => c.line === 0)).toBe(true);
    expect(m.lines[0]!.chars).toEqual([0, 1, 2]);
    expect(m.warnings).toEqual([]);
  });

  it('Tr 2: even when the stroke callback is skipped, the text of the CharInfo of that glyph is "fi"', () => {
    const m = extractMultiChar(2, 'AB');
    expect(m.chars.map((c) => [c.text, c.render])).toEqual([
      ['fi', 'fill-stroke'],
      ['B', 'fill-stroke'],
    ]);
  });

  it('Tr 4: even when the clip resend is consumed, text is "fi" once (the auxiliary character is not appended twice)', () => {
    const m = extractMultiChar(4, 'AB');
    expect(m.glyphCount).toBe(2);
    expect(m.chars.map((c) => [c.text, c.clip])).toEqual([
      ['fi', true],
      ['B', true],
    ]);
  });

  it('known limitation: for a glyph counted first in the clip callback like Tr 7, MuPDF does not send the auxiliary characters, so text is only the first character', () => {
    const m = extractMultiChar(7, 'AB');
    expect(m.chars.map((c) => c.text)).toEqual(['f', 'B']);
    expect(seqs(m)).toEqual([0, 1]);
  });

  it('unionQuads: merges quads of the same line along the line direction (including rotated lines)', async () => {
    const { unionQuads } = await import('../src/extract-stext.js');
    const ch = (quad: number[]) =>
      ({ quad }) as unknown as Parameters<typeof unionQuads>[0][number];
    expect(unionQuads([ch([0, 0, 5, 0, 0, 10, 5, 10])])).toEqual([0, 0, 5, 0, 0, 10, 5, 10]);
    expect(unionQuads([ch([0, 0, 5, 0, 0, 10, 5, 10]), ch([5, 0, 9, 0, 5, 10, 9, 10])])).toEqual([
      0, 0, 9, 0, 0, 10, 9, 10,
    ]);
    // A line running downward (ul→ur is +y).
    const down = unionQuads([ch([0, 0, 0, 5, -10, 0, -10, 5]), ch([0, 5, 0, 9, -10, 5, -10, 9])]);
    expect(down.map((v) => Math.round(v))).toEqual([0, 0, 0, 9, -10, 0, -10, 9]);
  });

  it.skipIf(!existsSync(DEJAVU))(
    'one ligature glyph arrives as the single character "fi" and does not misalign the pairing with the following characters',
    () => {
      const font = new mupdf.Font('DejaVu', readFileSync(DEJAVU));
      const gid = (c: string | number) => font.encodeCharacter(c).toString(16).padStart(4, '0');
      const m = extract({
        content: `BT /F3 14 Tf 10 150 Td <${gid('A')}${gid(0xfb01)}${gid('B')}> Tj ET`,
        resources: (doc, res) => {
          (res.Font as Record<string, unknown>).F3 = doc.addFont(font);
        },
      });
      expect(m.chars.map((c) => c.text)).toEqual(['A', 'fi', 'B']);
      expect(m.chars.every((c) => c.line === 0)).toBe(true);
      expect(m.lines[0]!.chars).toEqual([0, 1, 2]);
      expect(m.warnings).toEqual([]);
      // The quad of the ligature glyph merges the two characters 'f' and 'i' and reaches the origin of the following character 'B'.
      expect(m.chars[1]!.quad[2]).toBeCloseTo(m.chars[2]!.origin[0], 1);
    },
  );
});

describe('extractPage: wrapper ownership (mupdf.js Shade wrapper)', () => {
  it('repeatedly extracting a page with shades alongside GC does not corrupt the document', async () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const s = open([
      {
        content: 'q 10 10 80 80 re W n /Sh1 sh Q BT /F1 12 Tf 10 150 Td (shade) Tj ET',
        resources: (_doc, res) => {
          res.Shading = {
            Sh1: {
              ShadingType: 2,
              ColorSpace: 'DeviceRGB',
              Coords: [0, 0, 100, 0],
              Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 },
              Extend: [true, true],
            },
          };
        },
      },
    ]);
    for (let i = 0; i < 400; i++) {
      s.invalidatePageCache();
      expect(s.extractPage({ pageIndex: 0 }).shades).toHaveLength(1);
      if (i % 20 === 0) {
        gc();
        // Finalizers (FinalizationRegistry) run in the next task after GC.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    gc();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Reusing a released shade fails with "Unexpected mesh type".
    expect(s.renderPage({ pageIndex: 0, scale: 1 }).width).toBe(300);
    s.invalidatePageCache();
    expect(s.extractPage({ pageIndex: 0 }).shades).toHaveLength(1);
    s.close();
  });
});

describe('extractPage: WASM wrapper release (from M1 review)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Counts registrations and unregistrations of the class finalizer registry (wrapper creation = registration, destroy = unregistration). */
  function countWrappers(cls: { _finalizer?: FinalizationRegistry<unknown> }) {
    const registry = cls._finalizer!;
    const register = vi.spyOn(registry, 'register');
    const unregister = vi.spyOn(registry, 'unregister');
    return () => ({ created: register.mock.calls.length, released: unregister.mock.calls.length });
  }

  it('also releases text wrappers inside a soft mask (skipped by the guard)', () => {
    // The registry is created at the first wrapper creation.
    new mupdf.Text().destroy();
    const s = open([
      {
        content: 'q /GsM gs 0 0 1 rg 0 0 100 100 re f Q BT /F1 12 Tf 10 150 Td (after) Tj ET',
        resources: softMaskResources,
      },
    ]);
    const page = s.document.loadPage(0);
    const counts = countWrappers(mupdf.Text as never);
    const { model } = extractPageDetailed(page, { pageIndex: 0 });
    const c = counts();
    page.destroy();
    s.close();
    expect(text(model)).toBe('after');
    // Mask group character M and body characters: at least 2 text callbacks.
    expect(c.created).toBeGreaterThanOrEqual(2);
    expect(c.released).toBe(c.created);
  });

  it('releases the Font wrapper created for every structured text character', () => {
    new mupdf.Font('Helvetica').destroy();
    const s = open([
      `BT /F1 12 Tf 10 150 Td (Hello) Tj ET BT /F2 14 Tf 10 100 Td ${hexGlyphs('한글')} Tj ET`,
    ]);
    const page = s.document.loadPage(0);
    const counts = countWrappers(mupdf.Font as never);
    const data = readStructuredText(page);
    const c = counts();
    page.destroy();
    s.close();
    expect(data.chars).toHaveLength(7);
    expect(c.created).toBeGreaterThanOrEqual(7);
    expect(c.released).toBe(c.created);
  });
});
