/**
 * 구조화 텍스트(`Page.toStructuredText`) 순회와 Device 글리프와의 결합.
 * 결합 키는 원점이다(같은 `fz_text` 에서 나온 값이라 오차가 부동소수 반올림 수준이다). 같은 원점에
 * 후보가 여럿이면 유니코드가 같은 것을 먼저 고른다. 세로쓰기는 구조화 텍스트 원점이 Device 원점에서 세로
 * 전진 벡터만큼 떨어져 있으므로(`stextOriginOf`) 그 점으로 찾는다.
 */
import type * as mupdf from 'mupdf';
import type { Point, Quad, RGB, Rect } from '@pdf-editor/shared-types';
import type { RawGlyph } from './extract-device.js';

export interface StextChar {
  /** `String.fromCharCode(c)` 의 코드 유닛(mupdf.js 는 BMP 밖 코드포인트를 잘라서 준다). */
  rune: number;
  origin: Point;
  quad: Quad;
  /** 구조화 텍스트가 가진 sRGB(8비트 단위). */
  rgb: RGB;
  /** StextData.lines 인덱스. */
  line: number;
  /** 줄 안 순서. */
  indexInLine: number;
  /** 결합된 Device 글리프 인덱스. 짝이 없으면 -1. */
  owner: number;
  /** 글리프 하나가 여러 글자(합자·다중 글자 ToUnicode)일 때 함께 소비한 뒷 글자들(주 글자에만 채운다). */
  parts: StextChar[];
}

export interface StextLine {
  bbox: Rect;
  wmode: 0 | 1;
  dir: Point;
  block: number;
  chars: StextChar[];
}

export interface StextBlock {
  bbox: Rect;
  lines: number[];
}

export interface StextData {
  chars: StextChar[];
  lines: StextLine[];
  blocks: StextBlock[];
}

/** 원점이 사실상 같다고 볼 오차(pt). */
const TIGHT_EPS = 0.05;
/** 원점이 어긋난 후보도 찾는 최대 거리(pt). 세로쓰기 등에서 기준점이 조금 다를 때를 위한 여유다. */
const SEARCH_RADIUS = 1;

export function readStructuredText(page: mupdf.Page): StextData {
  const data: StextData = { chars: [], lines: [], blocks: [] };
  const st = page.toStructuredText('');
  try {
    let block = -1;
    let line = -1;
    st.walk({
      beginTextBlock(bbox) {
        block = data.blocks.length;
        data.blocks.push({ bbox: bbox as Rect, lines: [] });
      },
      beginLine(bbox, wmode, dir) {
        line = data.lines.length;
        data.lines.push({
          bbox: bbox as Rect,
          wmode: wmode === 1 ? 1 : 0,
          dir: dir as Point,
          block,
          chars: [],
        });
        data.blocks[block]!.lines.push(line);
      },
      onChar(c, origin, _font, _size, quad, color) {
        const lineData = data.lines[line]!;
        const ch: StextChar = {
          rune: c.charCodeAt(0),
          origin: origin as Point,
          quad: quad as Quad,
          rgb: color as RGB,
          line,
          indexInLine: lineData.chars.length,
          owner: -1,
          parts: [],
        };
        lineData.chars.push(ch);
        data.chars.push(ch);
      },
    });
  } finally {
    st.destroy();
  }
  return data;
}

/** 원점 격자(1pt 칸). 후보 탐색을 3×3 칸으로 줄인다. */
class OriginGrid {
  #cells = new Map<string, StextChar[]>();

  constructor(chars: readonly StextChar[]) {
    for (const ch of chars) {
      const key = OriginGrid.key(ch.origin[0], ch.origin[1]);
      const cell = this.#cells.get(key);
      if (cell) cell.push(ch);
      else this.#cells.set(key, [ch]);
    }
  }

  static key(x: number, y: number): string {
    return `${Math.floor(x)},${Math.floor(y)}`;
  }

  *near(x: number, y: number): Generator<StextChar> {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = this.#cells.get(`${cx + dx},${cy + dy}`);
        if (cell) yield* cell;
      }
    }
  }
}

/** 유니코드 한 글자의 문자열. 매핑이 없거나 잘못된 값이면 null. */
function codePointText(unicode: number): string | null {
  if (!Number.isInteger(unicode) || unicode <= 0 || unicode > 0x10ffff) return null;
  if (unicode >= 0xd800 && unicode <= 0xdfff) return null;
  return String.fromCodePoint(unicode);
}

/**
 * Device 글리프가 나타내는 유니코드 문자열. 추가 유니코드(ToUnicode 다중 글자)를 이어 붙이고,
 * 합자 코드포인트(U+FB00–FB06)는 NFKC 로 전개한다. 매핑이 없으면 "�".
 */
export function glyphText(unicode: number, extra: readonly number[] = []): string {
  const base = codePointText(unicode);
  if (base === null) return '\uFFFD';
  let text =
    extra.length === 0 && unicode >= 0xfb00 && unicode <= 0xfb06 ? base.normalize('NFKC') : base;
  for (const e of extra) text += codePointText(e) ?? '';
  return text;
}

/**
 * 구조화 텍스트가 이 글리프에 두는 원점(페이지 공간). 가로쓰기는 Device 원점과 같다. 세로쓰기(wmode 1)는
 * MuPDF stext 가 글리프 원점에 세로 전진 벡터(폰트 세로 advance × 글리프 행렬로 옮긴 (0, −1))를 더한 점을
 * 원점으로 둔다(1.28.1 실측: 다음 글리프의 Device 원점과 같다. 회전·Tz·Tc 에서도 성립).
 */
function stextOriginOf(g: RawGlyph): Point {
  if (g.wmode !== 1) return [g.m[4], g.m[5]];
  return [g.m[4] - g.advance * g.m[2], g.m[5] - g.advance * g.m[3]];
}

/**
 * 글리프 순서대로 구조화 텍스트 글자를 하나씩 소비한다. 반환 배열은 글리프마다 짝(없으면 null).
 * 합자 글리프는 구조화 텍스트가 전개한 글자들(`f`,`i`)을 줄 순서대로 함께 소비한다.
 * 짝이 남은 구조화 텍스트 글자(Tr 4–6 중복 줄, 합성 공백, 주석 텍스트)는 `owner` 가 -1 인 채 남는다.
 */
export function matchGlyphs(glyphs: readonly RawGlyph[], data: StextData): Array<StextChar | null> {
  const grid = new OriginGrid(data.chars);
  const matches: Array<StextChar | null> = new Array(glyphs.length).fill(null);
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i]!;
    const text = glyphText(g.unicode, g.extra);
    const wanted = text.charCodeAt(0);
    // 세로쓰기는 전진 벡터만큼 옮긴 점을 먼저 찾고, 없으면 Device 원점으로 한 번 더 찾는다.
    const points: Point[] = [stextOriginOf(g)];
    if (g.wmode === 1) points.push([g.m[4], g.m[5]]);
    let best: StextChar | null = null;
    for (const [x, y] of points) {
      let bestScore = Infinity;
      for (const ch of grid.near(x, y)) {
        if (ch.owner !== -1) continue;
        const d = Math.hypot(ch.origin[0] - x, ch.origin[1] - y);
        if (d > SEARCH_RADIUS) continue;
        // 원점이 사실상 같으면 유니코드가 같은 쪽(0)을 먼저, 다르면(1) 그다음. 어긋난 후보는 거리순.
        const score = d <= TIGHT_EPS ? (ch.rune === wanted ? 0 : 1) : 2 + d;
        if (score < bestScore || (score === bestScore && best && isBefore(ch, best))) {
          best = ch;
          bestScore = score;
        }
      }
      if (best) break;
    }
    if (!best) continue;
    best.owner = i;
    matches[i] = best;
    if (text.length > 1) claimExtraParts(best, text, data, i);
  }
  return matches;
}

/** 구조화 텍스트 순서(줄 번호, 줄 안 순서)로 앞서는지. */
function isBefore(a: StextChar, b: StextChar): boolean {
  return a.line !== b.line ? a.line < b.line : a.indexInLine < b.indexInLine;
}

/**
 * 글리프 하나가 여러 글자(합자·ToUnicode 다중 글자)면 구조화 텍스트도 글자를 전개해 같은 줄에 이어
 * 놓는다(뒷 글자 원점은 다음 글리프 원점에 걸친다). 뒷 글자를 같은 글리프가 소비해야 다음 글리프의
 * 짝과 섞이지 않는다.
 */
function claimExtraParts(
  first: StextChar,
  text: string,
  data: StextData,
  glyphIndex: number,
): void {
  const line = data.lines[first.line]!;
  for (let k = 1; k < text.length; k++) {
    const next = line.chars[first.indexInLine + k];
    if (!next || next.owner !== -1 || next.rune !== text.charCodeAt(k)) return;
    next.owner = glyphIndex;
    first.parts.push(next);
  }
}

/**
 * 글리프 하나에 대응하는 구조화 텍스트 글자들의 quad 를 합친다. 첫 글자의 줄 방향(ul→ur)으로 모든 꼭짓점을
 * 투영해 가장 앞·뒤를 잡고, 높이(ul→ll)는 첫 글자 것을 쓴다. 글자가 하나면 그 quad 그대로다.
 */
export function unionQuads(chars: readonly StextChar[]): Quad {
  const first = chars[0]!.quad;
  if (chars.length === 1) return first;
  const ux = first[2] - first[0];
  const uy = first[3] - first[1];
  const len = Math.hypot(ux, uy) || 1;
  const dx = ux / len;
  const dy = uy / len;
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const ch of chars) {
    for (let i = 0; i < 8; i += 2) {
      const t = (ch.quad[i]! - first[0]) * dx + (ch.quad[i + 1]! - first[1]) * dy;
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
  }
  const hx = first[4] - first[0];
  const hy = first[5] - first[1];
  const ulx = first[0] + dx * tMin;
  const uly = first[1] + dy * tMin;
  const urx = first[0] + dx * tMax;
  const ury = first[1] + dy * tMax;
  return [ulx, uly, urx, ury, ulx + hx, uly + hy, urx + hx, ury + hy];
}
