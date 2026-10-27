import { describe, expect, it } from 'vitest';
import { layoutParagraph, type WritableGlyph } from '../src/index.js';
import { cmapPreimage, hmtxAdvance } from '../src/opentype.js';
import { format, notoBytes, notoFace, seg, stable } from './helpers.js';

// Bundled fallback font (Noto Sans KR subset, upem 1000): 1/1000 em = font unit.
const bytes = notoBytes();
const hmtx = (gid: number) => hmtxAdvance('fallback', bytes, gid);
const face = notoFace(hmtx);
const cmap = new Map<number, number>();
for (const [gid, cps] of cmapPreimage('fallback', bytes)) for (const cp of cps) cmap.set(cp, gid);
const gidOf = (ch: string): number => cmap.get(ch.codePointAt(0) ?? 0) ?? -1;

function run(text: string, width = 1000) {
  return layoutParagraph({
    text,
    segments: [seg(face, 0, text.length)],
    format: format({ area: [0, 0, width, 1000] }),
    areaLimit: [0, 0, 1000, 1000],
  });
}
const gids = (lines: WritableGlyph[][]) => lines.flat().map((g) => g.gid);

describe('opentype shaper (harfbuzz, kern only)', () => {
  it('applies kern and carries the /W width on write glyphs', () => {
    const r = run('To');
    const [t, o] = r.lines[0] ?? [];
    const kern = -76;
    expect(t?.pdfWidth).toBe(hmtx(gidOf('T')));
    expect((o?.x ?? 0) - (t?.x ?? 0)).toBeCloseTo(((hmtx(gidOf('T')) + kern) / 1000) * 10, 9);
    expect(r.summary.glyphs[0]?.advance).toBeCloseTo(((hmtx(gidOf('T')) + kern) / 1000) * 10, 9);
  });

  it('the next kerning of the last cluster on a line is subtracted', () => {
    const tWidth = (hmtx(gidOf('T')) / 1000) * 10;
    const r = run('To', tWidth + 0.5);
    expect(r.summary.lines).toHaveLength(2);
    expect(r.summary.lines[0]?.x1).toBeCloseTo(tWidth, 9);
    expect(r.summary.glyphs[0]?.advance).toBeCloseTo(tWidth, 9);
  });

  it('does no ligatures or contextual substitution (fi, office and dashes all use the cmap gid)', () => {
    for (const text of ['fi', 'office', '——', 'ffl']) {
      expect(gids(run(text).lines)).toEqual([...text].map(gidOf));
    }
  });

  it('no language tag is used, so spaces in Korean sentences are also cmap space glyphs', () => {
    const r = run('한글 fi');
    const space = r.lines[0]?.[2];
    expect(space?.gid).toBe(gidOf(' '));
    expect(r.summary.glyphs[2]?.advance).toBeCloseTo(2.24, 9);
  });

  it('the write code is a 2-byte gid (Identity-H)', () => {
    const g = run('漢').lines[0]?.[0];
    expect([...(g?.code ?? [])]).toEqual([(gidOf('漢') >> 8) & 0xff, gidOf('漢') & 0xff]);
  });

  it('default-ignorable characters hidden by harfbuzz are not written as space glyphs (ZWJ, SHY, ZWSP)', () => {
    // harfbuzz emits the ZWJ in "a‍b" as a space gid -> replace the cluster with the cmap gid.
    expect(gids(run('a\u200Db').lines)).toEqual([gidOf('a'), gidOf('b')]);
    const shy = run('a\u00ADb');
    expect(gids(shy.lines)).toEqual([gidOf('a'), gidOf('b')]);
    expect(shy.summary.glyphs[1]?.font.kind).toBe('missing');
    expect(gids(run('a\u200Bb').lines)).toEqual([gidOf('a'), gidOf('b')]);
  });

  it('characters missing from the fallback font are not written (missing)', () => {
    // Old Hangul conjoining jamo and pictographs are not in the bundled subset (contract 1.4).
    const r = run('a\u1100\u1161😀b');
    expect(r.summary.glyphs.map((g) => g.font.kind)).toEqual([
      'fallback',
      'missing',
      'missing',
      'fallback',
    ]);
    expect(gids(r.lines)).toEqual([gidOf('a'), gidOf('b')]);
  });

  it('even with mixed scripts, every gid is the cmap gid of its own cluster', () => {
    const text = 'Hello, 한글 漢字 カナ ひらがな Ελληνικά Кириллица € ™ “quote” (괄호) 1–2';
    const r = run(text);
    for (const g of r.lines.flat()) {
      const cluster = text.slice(g.offset, g.offset + g.length);
      expect([...cluster].map(gidOf)).toContain(g.gid);
    }
  });

  it('same input gives the same result', () => {
    const text = '가나다 To Wa 漢字 office\n끝';
    expect(stable(run(text, 60))).toEqual(stable(run(text, 60)));
  });
});
