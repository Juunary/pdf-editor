/**
 * V6(계약 6.1): harfbuzzjs 1.6.2(kern 만)가 번들 Noto Sans KR 서브셋을 읽고, 글리프 전진량이 MuPDF addFont 의 /W 와 같으며
 * (1/1000 em 반올림 차이 허용), 출력 gid 가 ToUnicode 로 왕복하는지 확인한다. 결과는 docs/m3-reflow.md 3절.
 */
import * as mupdf from 'mupdf';
import { beforeAll, describe, expect, it } from 'vitest';
import { layoutParagraph, type WritableGlyph } from '../src/index.js';
import { cmapPreimage, hmtxAdvance } from '../src/opentype.js';
import { classifyCluster, isDefaultIgnorable } from '../src/text.js';
import { format, notoBytes, notoFace, seg } from './helpers.js';

const bytes = notoBytes();

/** /W 배열 → cid → 폭. */
function parseW(w: mupdf.PDFObject): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < w.length;) {
    const first = w.get(i).asNumber();
    const next = w.get(i + 1);
    if (next.isArray()) {
      for (let k = 0; k < next.length; k++) out.set(first + k, next.get(k).asNumber());
      i += 2;
    } else {
      const width = w.get(i + 2).asNumber();
      for (let c = first; c <= next.asNumber(); c++) out.set(c, width);
      i += 3;
    }
  }
  return out;
}

/** ToUnicode CMap(bfchar·bfrange) → cid → 문자열. */
function parseToUnicode(cmap: string): Map<number, string> {
  const out = new Map<number, string>();
  const hex = (h: string) => parseInt(h, 16);
  const utf16 = (h: string) => {
    const units: number[] = [];
    for (let i = 0; i < h.length; i += 4) units.push(hex(h.slice(i, i + 4)));
    return String.fromCharCode(...units);
  };
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g;
    for (const m of (block[1] ?? '').matchAll(re)) {
      const lo = hex(m[1] ?? '0');
      const hi = hex(m[2] ?? '0');
      if (m[3] !== undefined) {
        const base = utf16(m[3]).codePointAt(0) ?? 0;
        for (let c = lo; c <= hi; c++) out.set(c, String.fromCodePoint(base + c - lo));
      } else {
        [...(m[4] ?? '').matchAll(/<([0-9a-fA-F]+)>/g)].forEach((it, k) =>
          out.set(lo + k, utf16(it[1] ?? '')),
        );
      }
    }
  }
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of (block[1] ?? '').matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      out.set(hex(m[1] ?? '0'), utf16(m[2] ?? ''));
    }
  }
  return out;
}

const hmtx = (gid: number) => hmtxAdvance('fallback', bytes, gid);

let doc: mupdf.PDFDocument;
let fontRef: mupdf.PDFObject;
let widths: Map<number, number>;
let toUnicode: Map<number, string>;
let preimage: Map<number, number[]>;
/** 다대일 cmap gid(ToUnicode 가 한 코드 포인트만 돌려줌). */
let conflicts: Map<number, number[]>;

beforeAll(() => {
  doc = new mupdf.PDFDocument();
  fontRef = doc.addFont(new mupdf.Font('NotoSansKR', bytes));
  const desc = fontRef.get('DescendantFonts').get(0);
  widths = parseW(desc.get('W'));
  toUnicode = parseToUnicode(fontRef.get('ToUnicode').readStream().asString());
  preimage = cmapPreimage('fallback', bytes);
  conflicts = new Map([...preimage].filter(([, cps]) => cps.length > 1));
});

/** /W 를 pdfWidth 로 쓰는 폴백 폰트(쓰기 경로와 같은 조건). */
const face = () => notoFace((gid) => widths.get(gid) ?? 1000);

function layoutAll(text: string): WritableGlyph[] {
  return layoutParagraph({
    text,
    segments: [seg(face(), 0, text.length)],
    format: format({ area: [0, 0, 500, 100_000] }),
    areaLimit: [0, 0, 500, 100_000],
  }).lines.flat();
}

describe('V6 폴백 폰트 /W·ToUnicode', () => {
  it('MuPDF addFont 는 Identity-H CIDFontType2(CIDToGIDMap 없음 = Identity)', () => {
    const desc = fontRef.get('DescendantFonts').get(0);
    expect(fontRef.get('Encoding').asName()).toBe('Identity-H');
    expect(desc.get('Subtype').asName()).toBe('CIDFontType2');
    const map = desc.get('CIDToGIDMap');
    expect(map.isNull() || map.asName() === 'Identity').toBe(true);
  });

  it('모든 글리프의 /W = harfbuzz hmtx 전진량(1/1000 em 반올림 허용)', () => {
    expect(widths.size).toBe(16_968);
    let maxDiff = 0;
    for (let gid = 0; gid < 16_968; gid++) {
      const w = widths.get(gid);
      expect(w).toBeDefined();
      maxDiff = Math.max(maxDiff, Math.abs((w ?? 0) - hmtx(gid)));
    }
    expect(maxDiff).toBeLessThanOrEqual(1);
    // 실측(2026-10-19): 차이 0.
    expect(maxDiff).toBe(0);
  });

  it('cmap 의 모든 gid 가 ToUnicode 를 가진다. 일대일 gid 는 정확히 왕복한다', () => {
    expect(preimage.size).toBe(16_569);
    let exact = 0;
    for (const [gid, cps] of preimage) {
      const t = toUnicode.get(gid);
      expect(t).toBeDefined();
      if (cps.length === 1) {
        expect(t).toBe(String.fromCodePoint(cps[0] ?? 0));
        exact++;
      }
    }
    expect(exact).toBe(16_569 - conflicts.size);
  });

  it('계약 불일치: 다대일 gid 317개는 MuPDF ToUnicode 가 가장 큰 코드 포인트를 고른다', () => {
    expect(conflicts.size).toBe(317);
    for (const [gid, cps] of conflicts) {
      expect(toUnicode.get(gid)).toBe(String.fromCodePoint(Math.max(...cps)));
    }
    const pick = (ch: string) => toUnicode.get(preimage.size && gidOfCp(ch.codePointAt(0) ?? 0));
    expect(pick(' ')).toBe('\u00A0');
    expect(pick('-')).toBe('\u2011');
    expect(pick('ㄱ')).toBe('\uFFA1');
    expect(pick('不')).toBe('\uF967');
  });

  it('배치 출력: 모든 gid 가 ToUnicode 를 갖고, 다대일 gid 를 뺀 클러스터는 정확히 왕복한다', () => {
    // NFC 안정 cmap 문자 전부를 한 글자씩 강제 줄바꿈으로 나눠 배치한다(이웃 글자와 클러스터를 만들지 않게).
    const chars = [...preimage.values()]
      .flat()
      .sort((a, b) => a - b)
      .map((cp) => String.fromCodePoint(cp))
      .filter((ch) => ch.normalize('NFC') === ch && classifyCluster(ch).cls !== 'BK');
    const text = chars.join('\n');
    const glyphs = layoutAll(text);
    const written = new Set(glyphs.map((g) => text.slice(g.offset, g.offset + g.length)));
    const mismatched: string[] = [];
    for (const g of glyphs) {
      const t = toUnicode.get(g.gid);
      expect(t).toBeDefined();
      const cluster = text.slice(g.offset, g.offset + g.length);
      if (t !== cluster) {
        expect(conflicts.has(g.gid)).toBe(true);
        mismatched.push(cluster);
      }
    }
    // 쓰지 않은 문자는 기본 무시 문자뿐이다(폴백 폰트로 쓰지 않음).
    const unwritten = chars.filter((ch) => !written.has(ch));
    expect(unwritten.every((ch) => isDefaultIgnorable(ch.codePointAt(0) ?? 0))).toBe(true);
    // 왕복이 깨지는 문자 = 다대일 gid 의 큰 코드 포인트가 아닌 쪽(NFC 안정, 기본 무시 문자 제외).
    const expected = [...conflicts.values()].flatMap((cps) =>
      cps
        .filter((cp) => cp !== Math.max(...cps) && !isDefaultIgnorable(cp))
        .map((cp) => String.fromCodePoint(cp))
        .filter((ch) => ch.normalize('NFC') === ch),
    );
    expect(new Set(mismatched)).toEqual(new Set(expected));
    // 실측(2026-10-19): 316자(ASCII 2·일반 구두점 3·CJK 기호 1·호환 자모 51·CJK 통합 한자 259).
    expect(mismatched.length).toBe(316);
    expect(glyphs.length).toBe(chars.length - unwritten.length);
  });

  it('MuPDF 추출 왕복(표본 문장): 다대일 gid 문자만 바뀐다', () => {
    const text = '한글 PDF 편집기 漢字 不可 ㄱㄴ “quote” — dash € ™ office fi To-day 2026';
    const glyphs = layoutAll(text);
    const H = 200;
    const ops = glyphs.map((g) => {
      const hex = [...g.code].map((b) => b.toString(16).padStart(2, '0')).join('');
      return `${g.size} 0 0 ${g.size} ${g.x.toFixed(4)} ${(H - g.y).toFixed(4)} Tm <${hex}> Tj`;
    });
    const resources = doc.newDictionary();
    const fonts = doc.newDictionary();
    fonts.put('F1', fontRef);
    resources.put('Font', fonts);
    const page = doc.addPage([0, 0, 600, H], 0, resources, `BT /F1 1 Tf ${ops.join(' ')} ET`);
    doc.insertPage(-1, page);
    const out = doc
      .loadPage(doc.countPages() - 1)
      .toStructuredText('preserve-whitespace')
      .asText();
    const strip = (s: string) => s.replace(/\s+/g, '');
    const viaToUnicode = [...text]
      .map((ch) => {
        const gid = gidOfCp(ch.codePointAt(0) ?? 0);
        return conflicts.has(gid) ? (toUnicode.get(gid) ?? ch) : ch;
      })
      .join('');
    expect(strip(out)).toBe(strip(viaToUnicode));
    // 실측: 不 → U+F967, ㄱ → U+FFA1, - → U+2011 로 추출된다(공백 → U+00A0 은 공백류라 비교에서 빠진다).
    expect(strip(out)).not.toBe(strip(text));
    expect(out).toContain('\uF967');
    expect(out).toContain('\uFFA1');
    expect(out).toContain('\u2011');
  });
});

/** cmap 코드 포인트 → gid. */
function gidOfCp(cp: number): number {
  for (const [gid, cps] of preimage) if (cps.includes(cp)) return gid;
  return -1;
}
