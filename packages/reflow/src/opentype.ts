/**
 * 폴백 폰트 셰이퍼(계약 D5): harfbuzzjs 로 kern 만 켜고 셰이핑한다. liga·clig·dlig·calt·ccmp·locl·rlig 는 끄고 언어 태그는
 * 쓰지 않는다(guessSegmentProperties 를 부르지 않아 기본 언어가 들어가지 않는다). 스크립트는 클러스터 단위로 나눠 정한다.
 *
 * 불변식: 쓰는 gid 는 모두 그 클러스터 자기 코드 포인트의 cmap gid 다(계약의 "cmap 역상" 보다 좁다. 숨긴 기본 무시 문자가
 * 공백 글리프가 되는 경우도 거른다). 어긋나거나 harfbuzz 가 클러스터를 합치면 그 클러스터는 cmap gid + hmtx 폭으로 대신한다.
 */
import * as hb from 'harfbuzzjs';
import type { ShapeResult, ShapedCluster, ShapedGlyph } from './shaper.js';
import { codePoints, isDefaultIgnorable } from './text.js';

/** 끄는 GSUB 기능(계약 D5). 켜는 기능은 kern 하나다. */
export const OPENTYPE_FEATURES_OFF = [
  'liga',
  'clig',
  'dlig',
  'calt',
  'ccmp',
  'locl',
  'rlig',
] as const;

const FEATURES = [
  new hb.Feature('kern', 1),
  ...OPENTYPE_FEATURES_OFF.map((tag) => new hb.Feature(tag, 0)),
];

interface OtFont {
  bytes: Uint8Array;
  font: hb.Font;
  /** 폰트 단위 → 1/1000 em. */
  scale: number;
  nominal: Map<number, number | null>;
  hAdvance: Map<number, number>;
}

/** 폰트 키별 harfbuzz 폰트. 폴백 폰트는 문서당 1개라 작게 둔다. */
const fonts = new Map<string, OtFont>();
const MAX_FONTS = 4;

function loadFont(key: string, bytes: Uint8Array): OtFont {
  const hit = fonts.get(key);
  if (hit !== undefined && (hit.bytes === bytes || hit.bytes.length === bytes.length)) return hit;
  const face = new hb.Face(new hb.Blob(bytes));
  const font = new hb.Font(face);
  const entry: OtFont = {
    bytes,
    font,
    scale: 1000 / face.upem,
    nominal: new Map(),
    hAdvance: new Map(),
  };
  fonts.delete(key);
  fonts.set(key, entry);
  while (fonts.size > MAX_FONTS) {
    const oldest = fonts.keys().next().value;
    if (oldest === undefined) break;
    fonts.delete(oldest);
  }
  return entry;
}

function nominalGlyph(f: OtFont, cp: number): number | null {
  let g = f.nominal.get(cp);
  if (g === undefined) {
    g = f.font.nominalGlyph(cp) ?? null;
    f.nominal.set(cp, g);
  }
  return g;
}

function hAdvance(f: OtFont, gid: number): number {
  let a = f.hAdvance.get(gid);
  if (a === undefined) {
    a = f.font.glyphHAdvance(gid);
    f.hAdvance.set(gid, a);
  }
  return a;
}

/** 폴백 폰트 gid 의 쓰기 코드(Identity-H 2바이트, 계약 5.5). */
export function gidCode(gid: number): Uint8Array {
  return Uint8Array.of((gid >> 8) & 0xff, gid & 0xff);
}

const SCRIPT_TESTS: [RegExp, string][] = [
  [/\p{Script=Hangul}/u, 'Hang'],
  [/\p{Script=Latin}/u, 'Latn'],
  [/\p{Script=Han}/u, 'Hani'],
  [/\p{Script=Hiragana}/u, 'Hira'],
  [/\p{Script=Katakana}/u, 'Kana'],
  [/\p{Script=Greek}/u, 'Grek'],
  [/\p{Script=Cyrillic}/u, 'Cyrl'],
];
const RE_COMMON = /[\p{Script=Common}\p{Script=Inherited}]/u;
const scriptCache = new Map<number, string | null>();

/** ISO 15924 스크립트. 공통·상속 문자는 null(이웃 스크립트를 따른다). */
function scriptOf(cp: number): string | null {
  let s = scriptCache.get(cp);
  if (s === undefined) {
    const ch = String.fromCodePoint(cp);
    s = RE_COMMON.test(ch) ? null : (SCRIPT_TESTS.find(([re]) => re.test(ch))?.[1] ?? 'Zzzz');
    scriptCache.set(cp, s);
  }
  return s;
}

/** 공용 버퍼(동기 실행이라 재사용한다). */
let buffer: hb.Buffer | null = null;

/**
 * 연속 클러스터를 셰이핑한다. 스크립트가 바뀌는 곳에서 나눠 셰이핑하고(공통·상속 문자는 앞 스크립트, 맨 앞이면 뒤 스크립트),
 * 클러스터마다 harfbuzz 결과를 검사해 어긋나면 cmap gid + hmtx 폭으로 대신한다.
 */
export function shapeOpenType(
  key: string,
  bytes: Uint8Array,
  pdfWidth: (gid: number) => number,
  text: string,
  clusters: readonly (readonly [number, number])[],
): ShapeResult {
  const f = loadFont(key, bytes);
  const out: ShapeResult = new Array<ShapedCluster | null>(clusters.length).fill(null);
  const scripts = clusters.map(([s]) => scriptOf(text.codePointAt(s) ?? 0));
  const first = scripts.find((s) => s !== null) ?? 'Zyyy';
  let current = first;
  for (let i = 0; i < scripts.length; i++) scripts[i] = current = scripts[i] ?? current;
  let runStart = 0;
  for (let i = 1; i <= clusters.length; i++) {
    if (i === clusters.length || scripts[i] !== scripts[runStart]) {
      shapeRun(f, pdfWidth, text, clusters, runStart, i, scripts[runStart] ?? first, out);
      runStart = i;
    }
  }
  return out;
}

function shapeRun(
  f: OtFont,
  pdfWidth: (gid: number) => number,
  text: string,
  clusters: readonly (readonly [number, number])[],
  i0: number,
  i1: number,
  script: string,
  out: ShapeResult,
): void {
  const base = clusters[i0]?.[0] ?? 0;
  const end = clusters[i1 - 1]?.[1] ?? base;
  buffer ??= new hb.Buffer();
  buffer.reset();
  buffer.addText(text.slice(base, end));
  buffer.setDirection(hb.Direction.LTR);
  buffer.setScript(script);
  hb.shape(f.font, buffer, FEATURES);
  const infos = buffer.getGlyphInfos();
  const positions = buffer.getGlyphPositions();

  // 클러스터별 글리프 인덱스(LTR 이라 cluster 값은 단조 증가).
  const n = i1 - i0;
  const glyphsOf: number[][] = Array.from({ length: n }, () => []);
  let k = 0;
  for (let g = 0; g < infos.length; g++) {
    const v = base + (infos[g]?.cluster ?? 0);
    while (k < n - 1 && v >= (clusters[i0 + k]?.[1] ?? 0)) k++;
    glyphsOf[k]?.push(g);
  }
  // 글리프가 없는 클러스터는 앞 클러스터와 합쳐졌다(합자 등): 둘 다 대신한다.
  const bad = new Array<boolean>(n).fill(false);
  let lastWithGlyphs = -1;
  for (let j = 0; j < n; j++) {
    if ((glyphsOf[j]?.length ?? 0) === 0) {
      bad[j] = true;
      if (lastWithGlyphs >= 0) bad[lastWithGlyphs] = true;
    } else {
      lastWithGlyphs = j;
    }
  }
  for (let j = 0; j < n; j++) {
    const [s, e] = clusters[i0 + j] ?? [0, 0];
    const cps = codePoints(text.slice(s, e));
    const allowed = new Set<number>();
    for (const cp of cps) {
      const g = nominalGlyph(f, cp);
      if (g !== null) allowed.add(g);
    }
    const idx = glyphsOf[j] ?? [];
    if (!bad[j] && idx.every((g) => allowed.has(infos[g]?.codepoint ?? -1))) {
      const glyphs: ShapedGlyph[] = [];
      let advance = 0;
      for (const g of idx) {
        const gid = infos[g]?.codepoint ?? 0;
        const p = positions[g];
        const adv = (p?.xAdvance ?? 0) * f.scale;
        advance += adv;
        glyphs.push({
          gid,
          code: gidCode(gid),
          advance: adv,
          xOffset: (p?.xOffset ?? 0) * f.scale,
          pdfWidth: pdfWidth(gid),
        });
      }
      const lastGlyph = idx[idx.length - 1] ?? 0;
      const lastGid = infos[lastGlyph]?.codepoint ?? 0;
      const lastAdv = positions[lastGlyph]?.xAdvance ?? 0;
      // 0 전진(결합 표지 등)은 커닝으로 보지 않는다.
      const kernAfter = lastAdv === 0 ? 0 : (lastAdv - hAdvance(f, lastGid)) * f.scale;
      out[i0 + j] = { glyphs, advance, kernAfter };
    } else {
      out[i0 + j] = nominalCluster(f, pdfWidth, cps);
    }
  }
}

/** cmap gid + hmtx 폭(커닝 없음). 기본 무시 문자는 글리프가 없으면 건너뛴다. 그 밖의 글리프가 없으면 null. */
function nominalCluster(
  f: OtFont,
  pdfWidth: (gid: number) => number,
  cps: readonly number[],
): ShapedCluster | null {
  const glyphs: ShapedGlyph[] = [];
  let advance = 0;
  for (const cp of cps) {
    const gid = nominalGlyph(f, cp);
    if (gid === null) {
      if (isDefaultIgnorable(cp)) continue;
      return null;
    }
    const adv = hAdvance(f, gid) * f.scale;
    advance += adv;
    glyphs.push({ gid, code: gidCode(gid), advance: adv, xOffset: 0, pdfWidth: pdfWidth(gid) });
  }
  return glyphs.length === 0 ? null : { glyphs, advance, kernAfter: 0 };
}

/**
 * 폰트 cmap 의 gid → 코드 포인트 목록(시험·진단용). 다대일 gid 는 ToUnicode 로 한 코드 포인트만 돌려줄 수 있다.
 */
export function cmapPreimage(key: string, bytes: Uint8Array): Map<number, number[]> {
  const f = loadFont(key, bytes);
  const out = new Map<number, number[]>();
  for (const cp of f.font.face.collectUnicodes()) {
    const g = nominalGlyph(f, cp);
    if (g === null) continue;
    const list = out.get(g);
    if (list === undefined) out.set(g, [cp]);
    else list.push(cp);
  }
  return out;
}

/** gid 의 hmtx 전진량(1/1000 em, 시험·진단용). */
export function hmtxAdvance(key: string, bytes: Uint8Array, gid: number): number {
  const f = loadFont(key, bytes);
  return hAdvance(f, gid) * f.scale;
}
