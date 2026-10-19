import { describe, expect, it } from 'vitest';
import { layoutParagraph, type WritableGlyph } from '../src/index.js';
import { cmapPreimage, hmtxAdvance } from '../src/opentype.js';
import { format, notoBytes, notoFace, seg, stable } from './helpers.js';

// 번들 폴백 폰트(Noto Sans KR 서브셋, upem 1000): 1/1000 em = 폰트 단위.
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

describe('opentype 셰이퍼(harfbuzz, kern 만)', () => {
  it('kern 을 적용하고 쓰기 글리프에는 /W 폭을 싣는다', () => {
    const r = run('To');
    const [t, o] = r.lines[0] ?? [];
    const kern = -76;
    expect(t?.pdfWidth).toBe(hmtx(gidOf('T')));
    expect((o?.x ?? 0) - (t?.x ?? 0)).toBeCloseTo(((hmtx(gidOf('T')) + kern) / 1000) * 10, 9);
    expect(r.summary.glyphs[0]?.advance).toBeCloseTo(((hmtx(gidOf('T')) + kern) / 1000) * 10, 9);
  });

  it('줄 끝 클러스터의 다음 커닝은 뺀다', () => {
    const tWidth = (hmtx(gidOf('T')) / 1000) * 10;
    const r = run('To', tWidth + 0.5);
    expect(r.summary.lines).toHaveLength(2);
    expect(r.summary.lines[0]?.x1).toBeCloseTo(tWidth, 9);
    expect(r.summary.glyphs[0]?.advance).toBeCloseTo(tWidth, 9);
  });

  it('합자·문맥 대체를 하지 않는다(fi·office·대시 모두 cmap gid)', () => {
    for (const text of ['fi', 'office', '——', 'ffl']) {
      expect(gids(run(text).lines)).toEqual([...text].map(gidOf));
    }
  });

  it('언어 태그를 쓰지 않아 한국어 문장의 공백도 cmap 공백 글리프다', () => {
    const r = run('한글 fi');
    const space = r.lines[0]?.[2];
    expect(space?.gid).toBe(gidOf(' '));
    expect(r.summary.glyphs[2]?.advance).toBeCloseTo(2.24, 9);
  });

  it('쓰기 코드는 2바이트 gid(Identity-H)', () => {
    const g = run('漢').lines[0]?.[0];
    expect([...(g?.code ?? [])]).toEqual([(gidOf('漢') >> 8) & 0xff, gidOf('漢') & 0xff]);
  });

  it('harfbuzz 가 숨긴 기본 무시 문자는 공백 글리프로 쓰지 않는다(ZWJ·SHY·ZWSP)', () => {
    // harfbuzz 는 "a\u200Db" 의 ZWJ 를 공백 gid 로 낸다 → 클러스터를 cmap gid 로 대신.
    expect(gids(run('a\u200Db').lines)).toEqual([gidOf('a'), gidOf('b')]);
    const shy = run('a\u00ADb');
    expect(gids(shy.lines)).toEqual([gidOf('a'), gidOf('b')]);
    expect(shy.summary.glyphs[1]?.font.kind).toBe('missing');
    expect(gids(run('a\u200Bb').lines)).toEqual([gidOf('a'), gidOf('b')]);
  });

  it('폴백 폰트에 없는 글자는 쓰지 않는다(missing)', () => {
    // 옛한글 첫가끝 자모·그림 문자는 번들 서브셋에 없다(계약 1.4).
    const r = run('a\u1100\u1161😀b');
    expect(r.summary.glyphs.map((g) => g.font.kind)).toEqual([
      'fallback',
      'missing',
      'missing',
      'fallback',
    ]);
    expect(gids(r.lines)).toEqual([gidOf('a'), gidOf('b')]);
  });

  it('여러 스크립트가 섞여도 모든 gid 는 자기 클러스터의 cmap gid 다', () => {
    const text = 'Hello, 한글 漢字 カナ ひらがな Ελληνικά Кириллица € ™ “quote” (괄호) 1–2';
    const r = run(text);
    for (const g of r.lines.flat()) {
      const cluster = text.slice(g.offset, g.offset + g.length);
      expect([...cluster].map(gidOf)).toContain(g.gid);
    }
  });

  it('같은 입력이면 같은 결과', () => {
    const text = '가나다 To Wa 漢字 office\n끝';
    expect(stable(run(text, 60))).toEqual(stable(run(text, 60)));
  });
});
