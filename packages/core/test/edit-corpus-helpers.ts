/**
 * Corpus edit measurement tools (docs/m3-contract.md 8.2, 8.3): three-engine render and text, pixel comparison, sample sentence generation, object comparison.
 * Engines are called the same way as pdf-ops `test/helpers/engines.ts` (MuPDF, pdfjs-dist 6.4.299 legacy, Poppler pdftoppm/pdftotext).
 * Coordinates are in page space (MuPDF page coordinates). The render origin is the top-left of the page bounds (`origin`).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as mupdf from 'mupdf';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PlacedGlyph, Rect } from '@pdf-editor/shared-types';

const require = createRequire(import.meta.url);
const PDFJS_ROOT = dirname(require.resolve('pdfjs-dist/package.json'));
pdfjs.GlobalWorkerOptions.workerSrc = join(PDFJS_ROOT, 'legacy/build/pdf.worker.mjs');

export const SCALE = 2;
export type Engine = 'mupdf' | 'pdfjs' | 'poppler';
export const ENGINES: Engine[] = ['mupdf', 'pdfjs', 'poppler'];

export interface Raster {
  width: number;
  height: number;
  /** RGB, 3 channels. */
  data: Uint8Array;
}

export const popplerAvailable = (): boolean => !spawnSync('pdftoppm', ['-v']).error;

export const openMupdf = (bytes: Uint8Array): mupdf.PDFDocument =>
  mupdf.Document.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument;

/** Top-left of the page bounds (page space). */
export function pageOrigin(bytes: Uint8Array, pageIndex: number): [number, number] {
  const doc = openMupdf(bytes);
  try {
    const page = doc.loadPage(pageIndex);
    const b = page.getBounds();
    page.destroy();
    return [b[0], b[1]];
  } finally {
    doc.destroy();
  }
}

function mupdfRasterDoc(doc: mupdf.Document, pageIndex: number): Raster {
  const page = doc.loadPage(pageIndex);
  // showExtras=false: annotations excluded.
  const pix = page.toPixmap(
    mupdf.Matrix.scale(SCALE, SCALE),
    mupdf.ColorSpace.DeviceRGB,
    false,
    false,
  );
  try {
    return {
      width: pix.getWidth(),
      height: pix.getHeight(),
      data: new Uint8Array(pix.getPixels()),
    };
  } finally {
    pix.destroy();
    page.destroy();
  }
}

/** Renders several pages with MuPDF (opens once). */
export function mupdfRasters(bytes: Uint8Array, pages: number[]): Map<number, Raster> {
  const doc = openMupdf(bytes);
  try {
    return new Map(pages.map((p) => [p, mupdfRasterDoc(doc, p)]));
  } finally {
    doc.destroy();
  }
}

interface CanvasFactoryLike {
  create(
    w: number,
    h: number,
  ): {
    canvas: unknown;
    context: {
      getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
    };
  };
  destroy?(c: unknown): void;
}

async function openPdfjs(bytes: Uint8Array) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: `${join(PDFJS_ROOT, 'standard_fonts')}/`,
    cMapUrl: `${join(PDFJS_ROOT, 'cmaps')}/`,
    cMapPacked: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  const doc = await task.promise;
  return Object.assign(doc, { close: () => task.destroy() });
}

async function pdfjsRaster(bytes: Uint8Array, pageIndex: number): Promise<Raster> {
  const doc = await openPdfjs(bytes);
  try {
    const page = await doc.getPage(pageIndex + 1);
    const vp = page.getViewport({ scale: SCALE });
    const factory = (doc as unknown as { canvasFactory: CanvasFactoryLike }).canvasFactory;
    const w = Math.round(vp.width);
    const h = Math.round(vp.height);
    const { canvas, context } = factory.create(w, h);
    await page.render({
      canvas: canvas as never,
      canvasContext: context as never,
      viewport: vp,
      annotationMode: pdfjs.AnnotationMode.DISABLE,
    }).promise;
    const rgba = context.getImageData(0, 0, w, h).data;
    const data = new Uint8Array(w * h * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      // A transparent background is composited onto white.
      const a = rgba[i + 3]! / 255;
      data[j] = Math.round(rgba[i]! * a + 255 * (1 - a));
      data[j + 1] = Math.round(rgba[i + 1]! * a + 255 * (1 - a));
      data[j + 2] = Math.round(rgba[i + 2]! * a + 255 * (1 - a));
    }
    page.cleanup();
    return { width: w, height: h, data };
  } finally {
    await doc.close();
  }
}

function withTempPdf<T>(bytes: Uint8Array, f: (path: string, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'core-m3-corpus-'));
  try {
    const path = join(dir, 'in.pdf');
    writeFileSync(path, bytes);
    return f(path, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function popplerRaster(bytes: Uint8Array, pageIndex: number): Raster {
  return withTempPdf(bytes, (path, dir) => {
    const prefix = join(dir, 'out');
    const p = String(pageIndex + 1);
    const r = spawnSync('pdftoppm', [
      '-r',
      String(72 * SCALE),
      '-f',
      p,
      '-l',
      p,
      '-hide-annotations',
      '-cropbox',
      '-singlefile',
      path,
      prefix,
    ]);
    if (r.status !== 0) throw new Error(`pdftoppm 실패: ${r.stderr}`);
    const buf = readFileSync(`${prefix}.ppm`);
    const fields: string[] = [];
    let i = 0;
    while (fields.length < 4) {
      while (buf[i]! <= 0x20) i++;
      let s = '';
      while (buf[i]! > 0x20) s += String.fromCharCode(buf[i++]!);
      fields.push(s);
    }
    i++;
    const width = Number(fields[1]);
    const height = Number(fields[2]);
    return { width, height, data: new Uint8Array(buf.subarray(i, i + width * height * 3)) };
  });
}

export async function raster(
  engine: Engine,
  bytes: Uint8Array,
  pageIndex: number,
): Promise<Raster> {
  if (engine === 'mupdf') return mupdfRasters(bytes, [pageIndex]).get(pageIndex)!;
  if (engine === 'pdfjs') return pdfjsRaster(bytes, pageIndex);
  return popplerRaster(bytes, pageIndex);
}

export interface DiffResult {
  /** Number of pixels outside the allowed area with channel difference > 8. -1 if the sizes differ. */
  pixels: number;
  /** Bounding box of the differing pixels (page space). null if none. */
  bbox: Rect | null;
  /** Maximum channel difference among the differing pixels. */
  maxDelta: number;
}

/** Differing pixels of two renders outside the allowed area (page-space rectangles + margin pt) (contract 8.3). */
export function diffOutside(
  a: Raster,
  b: Raster,
  allow: readonly Rect[],
  origin: [number, number],
  margin = 2,
): DiffResult {
  if (a.width !== b.width || a.height !== b.height) return { pixels: -1, bbox: null, maxDelta: 0 };
  const mask = new Uint8Array(a.width * a.height);
  for (const r of allow) {
    const x0 = Math.max(0, Math.floor((r[0] - origin[0] - margin) * SCALE));
    const y0 = Math.max(0, Math.floor((r[1] - origin[1] - margin) * SCALE));
    const x1 = Math.min(a.width - 1, Math.ceil((r[2] - origin[0] + margin) * SCALE));
    const y1 = Math.min(a.height - 1, Math.ceil((r[3] - origin[1] + margin) * SCALE));
    for (let y = y0; y <= y1; y++) mask.fill(1, y * a.width + x0, y * a.width + x1 + 1);
  }
  let n = 0;
  let maxDelta = 0;
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const k = y * a.width + x;
      if (mask[k]) continue;
      const i = k * 3;
      const d = Math.max(
        Math.abs(a.data[i]! - b.data[i]!),
        Math.abs(a.data[i + 1]! - b.data[i + 1]!),
        Math.abs(a.data[i + 2]! - b.data[i + 2]!),
      );
      if (d > 8) {
        n++;
        if (d > maxDelta) maxDelta = d;
        if (x < bx0) bx0 = x;
        if (y < by0) by0 = y;
        if (x > bx1) bx1 = x;
        if (y > by1) by1 = y;
      }
    }
  }
  return {
    pixels: n,
    maxDelta,
    bbox:
      n === 0
        ? null
        : [
            bx0 / SCALE + origin[0],
            by0 / SCALE + origin[1],
            (bx1 + 1) / SCALE + origin[0],
            (by1 + 1) / SCALE + origin[1],
          ],
  };
}

/** Whether the whole render is the same (number of pixels with channel difference > 8). */
export const diffAll = (a: Raster, b: Raster): number => diffOutside(a, b, [], [0, 0], 0).pixels;

/** Number of ink pixels inside the rectangle (channel difference from white > 64). */
export function inkInside(a: Raster, r: Rect, origin: [number, number]): number {
  const x0 = Math.max(0, Math.floor((r[0] - origin[0]) * SCALE));
  const y0 = Math.max(0, Math.floor((r[1] - origin[1]) * SCALE));
  const x1 = Math.min(a.width, Math.ceil((r[2] - origin[0]) * SCALE));
  const y1 = Math.min(a.height, Math.ceil((r[3] - origin[1]) * SCALE));
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 3;
      if (255 - Math.min(a.data[i]!, a.data[i + 1]!, a.data[i + 2]!) > 64) n++;
    }
  }
  return n;
}

/** Glyph box: x..x+advance, baseline − 0.8·size .. baseline + 0.2·size (task definition). */
export function glyphBox(g: PlacedGlyph): Rect {
  const x0 = Math.min(g.x, g.x + g.advance);
  const x1 = Math.max(g.x, g.x + g.advance);
  return [x0, g.y - 0.8 * g.size, x1, g.y + 0.2 * g.size];
}

/** Page text (reading order). MuPDF structured text, pdf.js getTextContent. */
export async function pageText(engine: 'mupdf' | 'pdfjs', bytes: Uint8Array, pageIndex: number) {
  if (engine === 'mupdf') {
    const doc = openMupdf(bytes);
    try {
      const page = doc.loadPage(pageIndex);
      const st = page.toStructuredText('preserve-whitespace');
      const t = st.asText();
      st.destroy();
      page.destroy();
      return t;
    } finally {
      doc.destroy();
    }
  }
  const doc = await openPdfjs(bytes);
  try {
    const tc = await (await doc.getPage(pageIndex + 1)).getTextContent();
    return tc.items.map((i) => ('str' in i ? i.str + (i.hasEOL ? '\n' : '') : '')).join('');
  } finally {
    await doc.close();
  }
}

/**
 * Characters inside a box (contract 8.3 text check): MuPDF uses the glyph rectangle center, pdf.js uses the text item anchor (transform origin,
 * raised by 0.3 of the glyph height) and joins those inside box (+margin) in extraction order.
 */
export async function textInBox(
  engine: 'mupdf' | 'pdfjs',
  bytes: Uint8Array,
  pageIndex: number,
  box: Rect,
  origin: [number, number],
  margin = 1,
): Promise<string> {
  const inside = (x: number, y: number) =>
    x >= box[0] - margin && x <= box[2] + margin && y >= box[1] - margin && y <= box[3] + margin;
  if (engine === 'mupdf') {
    const doc = openMupdf(bytes);
    try {
      const page = doc.loadPage(pageIndex);
      const st = page.toStructuredText('preserve-whitespace');
      let out = '';
      st.walk({
        onChar: (c, _o, _f, _s, q) => {
          const cx = (q[0] + q[2] + q[4] + q[6]) / 4;
          const cy = (q[1] + q[3] + q[5] + q[7]) / 4;
          if (inside(cx, cy)) out += c;
        },
      });
      st.destroy();
      page.destroy();
      return out;
    } finally {
      doc.destroy();
    }
  }
  const doc = await openPdfjs(bytes);
  try {
    const page = await doc.getPage(pageIndex + 1);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    let out = '';
    for (const i of tc.items) {
      if (!('str' in i)) continue;
      const [x, y] = vp.convertToViewportPoint(i.transform[4] as number, i.transform[5] as number);
      const h = Math.abs(i.transform[3] as number) || 1;
      if (inside(x + origin[0], y + origin[1] - h * 0.3)) out += i.str;
    }
    return out;
  } finally {
    await doc.close();
  }
}

/** For the text check: removes whitespace and default-ignorable characters (Default_Ignorable_Code_Point, contract 8.3 amendment 4). */
export const squash = (s: string): string =>
  s.replace(/[\s\p{Default_Ignorable_Code_Point}]+/gu, '');

/** For the order check: squash + NFKC (absorbs per-engine differences such as the ligature ﬁ). */
export const orderNorm = (s: string): string => squash(s.normalize('NFKC'));

/** All occurrence positions. */
function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/**
 * Finds the position of the first or last character of `text` in `hay` as a unique substring.
 * which='head': the start position of the shortest prefix of text (length minLen..maxLen) that occurs only once in hay.
 * which='tail': the end position (last character index) of the unique suffix. 'not-found' if none, 'ambiguous' if several.
 */
export function locate(
  hay: string,
  text: string,
  which: 'head' | 'tail',
  minLen = 4,
  maxLen = 40,
): number | 'not-found' | 'ambiguous' {
  if (text.length === 0) return 'not-found';
  let sawAmbiguous = false;
  const lo = Math.min(minLen, text.length);
  for (let n = lo; n <= Math.min(maxLen, text.length); n++) {
    const sub = which === 'head' ? text.slice(0, n) : text.slice(text.length - n);
    const occ = occurrences(hay, sub);
    if (occ.length === 0) return sawAmbiguous ? 'ambiguous' : 'not-found';
    if (occ.length === 1) return which === 'head' ? occ[0]! : occ[0]! + n - 1;
    sawAmbiguous = true;
  }
  return sawAmbiguous ? 'ambiguous' : 'not-found';
}

// ---- Sample sentences ----

/** FNV-1a 32-bit. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const LATIN_WORDS = [
  'system',
  'model',
  'paragraph',
  'measure',
  'quality',
  'review',
  'report',
  'policy',
  'value',
  'process',
  'control',
  'result',
  'method',
  'analysis',
  'design',
  'standard',
  'support',
  'network',
  'service',
  'program',
  'project',
  'response',
  'evidence',
  'baseline',
  'update',
  'budget',
  'market',
  'figure',
  'table',
  'section',
  'national',
  'federal',
  'science',
  'energy',
  'water',
  'climate',
  'security',
  'risk',
  'data',
  'test',
  'edit',
  'layout',
  'reading',
  'order',
  'search',
  'copy',
  'the',
  'of',
  'and',
  'for',
  'with',
  'from',
  'into',
  'over',
  'under',
  'between',
  'within',
  'a',
  'an',
  'is',
  'are',
  'was',
  'be',
  'new',
  'old',
  'final',
  'annual',
  'rapid',
  'stable',
];

/** (ii) Latin sentence: seed = document id + paragraph id, length = original length × [0.7, 1.3). */
export function latinSentence(docId: string, paragraphId: number, originalLength: number): string {
  const r = rng(hash32(`${docId}#${paragraphId}#latin`));
  const target = Math.max(20, Math.round(originalLength * (0.7 + 0.6 * r())));
  const words: string[] = [];
  let len = 0;
  while (len < target - 1) {
    const w = LATIN_WORDS[Math.floor(r() * LATIN_WORDS.length)]!;
    words.push(w);
    len += w.length + 1;
  }
  let s = words.join(' ');
  if (s.length > target - 1) s = s.slice(0, target - 1).trimEnd();
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

/** (iii) Hangul sentence list: includes KS X 1001 Hanja, hyphens and digits. */
export const KOREAN_SENTENCES = [
  '이 문단은 2026년 10월 20일에 편집기로 고쳐 쓴 한글 문장입니다.',
  '大韓民國 문서 편집 시험 - 제3차 측정 결과를 기록합니다.',
  '본 보고서의 漢字 표기와 숫자 1,234는 그대로 유지되어야 합니다.',
  '새로 추가한 문장이 원래 자리에서 읽히는지 확인합니다 - 검색 시험.',
  '學校와 會社의 자료 12건을 다시 정리하여 결과표에 반영하였다.',
  '편집 영역 밖의 화면은 바뀌지 않아야 하며, 오차는 0픽셀이다.',
];

/** (iii) Add a Hangul sentence not in the original (contract 8.2): original text followed by a space + a list sentence. */
export function koreanSentence(docId: string, paragraphId: number): string {
  const r = rng(hash32(`${docId}#${paragraphId}#ko`));
  return KOREAN_SENTENCES[Math.floor(r() * KOREAN_SENTENCES.length)]!;
}

// ---- Object comparison ----

export interface PageObjects {
  /** FNV hash and length of the decoded content stream (concatenated if an array). */
  content: string;
  /** Top-level Resources keys and sub-dictionary keys (sorted). Includes inherited ones. */
  resources: string;
}

function dictKeys(obj: mupdf.PDFObject): string[] {
  const keys: string[] = [];
  if (obj.isDictionary()) obj.forEach((_v, k) => keys.push(String(k)));
  return keys.sort();
}

export function pageObjects(doc: mupdf.PDFDocument, pageIndex: number): PageObjects {
  const pageObj = doc.findPage(pageIndex);
  const contents = pageObj.get('Contents');
  const parts: Uint8Array[] = [];
  const read = (o: mupdf.PDFObject) => {
    const r = o.resolve();
    if (r.isStream()) parts.push(r.readStream().asUint8Array().slice());
  };
  if (contents.isArray()) for (let i = 0; i < contents.length; i++) read(contents.get(i));
  else if (!contents.isNull()) read(contents);
  let h = 0x811c9dc5;
  let len = 0;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) {
      h ^= p[i]!;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    len += p.length;
  }
  const res = pageObj.getInheritable('Resources').resolve();
  const resKeys = dictKeys(res).map((k) => {
    const sub = res.get(k).resolve();
    return sub.isDictionary() ? `${k}{${dictKeys(sub).join(',')}}` : k;
  });
  return { content: `${len}:${h.toString(16)}`, resources: resKeys.join(';') };
}
