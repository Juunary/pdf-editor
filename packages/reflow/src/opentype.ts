/**
 * Fallback font shaper (contract D5): shapes with harfbuzzjs with only kern enabled. liga, clig, dlig, calt, ccmp, locl and rlig are turned off, and no language tag is
 * used (guessSegmentProperties is not called, so no default language gets in). The script is determined per cluster.
 *
 * Invariant: every gid written is the cmap gid of the cluster's own code point (excluding default-ignorable characters) (narrower than the contract's "cmap inverse".
 * It also filters out the case where harfbuzz emits a default-ignorable character it hid as a space glyph). If it does not match, or harfbuzz merges clusters, that cluster is
 * replaced with the cmap gid + hmtx width.
 */
import * as hb from 'harfbuzzjs';
import type { ShapeResult, ShapedCluster, ShapedGlyph } from './shaper.js';
import { codePoints, isDefaultIgnorable } from './text.js';

/** GSUB features turned off (contract D5). The only feature turned on is kern. */
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
  /** Font units -> 1/1000 em. */
  scale: number;
  nominal: Map<number, number | null>;
  hAdvance: Map<number, number>;
}

/** harfbuzz font per font key. There is one fallback font per document, so keep this small. */
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

/** Write code for a fallback font gid (Identity-H 2 bytes, contract 5.5). */
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

/** ISO 15924 script. Common and inherited characters are null (they follow the neighboring script). */
function scriptOf(cp: number): string | null {
  let s = scriptCache.get(cp);
  if (s === undefined) {
    const ch = String.fromCodePoint(cp);
    s = RE_COMMON.test(ch) ? null : (SCRIPT_TESTS.find(([re]) => re.test(ch))?.[1] ?? 'Zzzz');
    scriptCache.set(cp, s);
  }
  return s;
}

/** Shared buffer (execution is synchronous, so it is reused). */
let buffer: hb.Buffer | null = null;

/**
 * Shapes consecutive clusters. Splits and shapes where the script changes (common/inherited characters take the preceding script, or the following one if first),
 * and checks the harfbuzz result for each cluster, replacing it with cmap gid + hmtx width if it does not match.
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

  // Glyph index per cluster (LTR, so cluster values increase monotonically).
  const n = i1 - i0;
  const glyphsOf: number[][] = Array.from({ length: n }, () => []);
  let k = 0;
  for (let g = 0; g < infos.length; g++) {
    const v = base + (infos[g]?.cluster ?? 0);
    while (k < n - 1 && v >= (clusters[i0 + k]?.[1] ?? 0)) k++;
    glyphsOf[k]?.push(g);
  }
  // A cluster with no glyph was merged with the preceding cluster (ligature etc.): replace both.
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
      const g = isDefaultIgnorable(cp) ? null : nominalGlyph(f, cp);
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
      // A 0 advance (combining mark etc.) is not treated as kerning.
      const kernAfter = lastAdv === 0 ? 0 : (lastAdv - hAdvance(f, lastGid)) * f.scale;
      out[i0 + j] = { glyphs, advance, kernAfter };
    } else {
      out[i0 + j] = nominalCluster(f, pdfWidth, cps);
    }
  }
}

/**
 * cmap gid + hmtx width (no kerning). Default-ignorable characters (ZWJ, SHY, variation selectors, etc.) are not written (they are characters harfbuzz also hides,
 * and writing the hidden space glyph would insert a space into extraction). Null if there is no glyph otherwise.
 */
function nominalCluster(
  f: OtFont,
  pdfWidth: (gid: number) => number,
  cps: readonly number[],
): ShapedCluster | null {
  const glyphs: ShapedGlyph[] = [];
  let advance = 0;
  for (const cp of cps) {
    if (isDefaultIgnorable(cp)) continue;
    const gid = nominalGlyph(f, cp);
    if (gid === null) return null;
    const adv = hAdvance(f, gid) * f.scale;
    advance += adv;
    glyphs.push({ gid, code: gidCode(gid), advance: adv, xOffset: 0, pdfWidth: pdfWidth(gid) });
  }
  return glyphs.length === 0 ? null : { glyphs, advance, kernAfter: 0 };
}

/**
 * Font cmap gid -> list of code points (for tests and diagnostics). A many-to-one gid can return only one code point through ToUnicode.
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

/** hmtx advance of a gid (1/1000 em, for tests and diagnostics). */
export function hmtxAdvance(key: string, bytes: Uint8Array, gid: number): number {
  const f = loadFont(key, bytes);
  return hAdvance(f, gid) * f.scale;
}
