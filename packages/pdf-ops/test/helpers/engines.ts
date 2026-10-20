/**
 * 세 엔진 비교(계약 8.3): MuPDF·pdf.js(pdfjs-dist 6.4.299, Node legacy 빌드)·Poppler(pdftoppm·pdftotext).
 * 렌더는 scale 2, 주석 제외, 채널 차 8 초과 픽셀 수. 영역은 페이지 공간(MuPDF 쪽 경계 기준).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as mupdf from 'mupdf';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Rect } from '@pdf-editor/shared-types';

const require = createRequire(import.meta.url);
const PDFJS_ROOT = dirname(require.resolve('pdfjs-dist/package.json'));
pdfjs.GlobalWorkerOptions.workerSrc = join(PDFJS_ROOT, 'legacy/build/pdf.worker.mjs');

export const SCALE = 2;
export type Engine = 'mupdf' | 'pdfjs' | 'poppler';
export const ENGINES: Engine[] = ['mupdf', 'pdfjs', 'poppler'];

export interface Raster {
  width: number;
  height: number;
  /** RGB 3채널. */
  data: Uint8Array;
}

export const popplerAvailable = (): boolean => !spawnSync('pdftoppm', ['-v']).error;

function mupdfRaster(bytes: Uint8Array, pageIndex: number): Raster {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  try {
    const page = doc.loadPage(pageIndex);
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
      // 투명 배경은 흰색으로 합성한다.
      const a = rgba[i + 3]! / 255;
      data[j] = Math.round(rgba[i]! * a + 255 * (1 - a));
      data[j + 1] = Math.round(rgba[i + 1]! * a + 255 * (1 - a));
      data[j + 2] = Math.round(rgba[i + 2]! * a + 255 * (1 - a));
    }
    return { width: w, height: h, data };
  } finally {
    await doc.close();
  }
}

function withTempPdf<T>(bytes: Uint8Array, f: (path: string, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'pdfops-m3-'));
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
  if (engine === 'mupdf') return mupdfRaster(bytes, pageIndex);
  if (engine === 'pdfjs') return pdfjsRaster(bytes, pageIndex);
  return popplerRaster(bytes, pageIndex);
}

/** 두 렌더의 다른 픽셀 수(allow 밖, 페이지 공간 사각형 + margin pt). 크기가 다르면 -1. origin = 쪽 경계 왼쪽 위. */
export function diffOutside(
  a: Raster,
  b: Raster,
  allow: readonly Rect[],
  origin: [number, number] = [0, 0],
  margin = 2,
): number {
  if (a.width !== b.width || a.height !== b.height) return -1;
  const boxes = allow.map((r) => [
    (r[0] - origin[0] - margin) * SCALE,
    (r[1] - origin[1] - margin) * SCALE,
    (r[2] - origin[0] + margin) * SCALE,
    (r[3] - origin[1] + margin) * SCALE,
  ]);
  let n = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (boxes.some((q) => x >= q[0]! && x <= q[2]! && y >= q[1]! && y <= q[3]!)) continue;
      const i = (y * a.width + x) * 3;
      if (
        Math.abs(a.data[i]! - b.data[i]!) > 8 ||
        Math.abs(a.data[i + 1]! - b.data[i + 1]!) > 8 ||
        Math.abs(a.data[i + 2]! - b.data[i + 2]!) > 8
      ) {
        n++;
      }
    }
  }
  return n;
}

/** 사각형 안 잉크(흰색과 채널 차 > 64) 픽셀 수. */
export function inkInside(a: Raster, r: Rect, origin: [number, number] = [0, 0]): number {
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

/** 쪽 텍스트(읽기 순서). */
export async function pageText(
  engine: Engine,
  bytes: Uint8Array,
  pageIndex: number,
): Promise<string> {
  if (engine === 'mupdf') {
    const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
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
  if (engine === 'pdfjs') {
    const doc = await openPdfjs(bytes);
    try {
      const tc = await (await doc.getPage(pageIndex + 1)).getTextContent();
      return tc.items.map((i) => ('str' in i ? i.str + (i.hasEOL ? '\n' : '') : '')).join('');
    } finally {
      await doc.close();
    }
  }
  return withTempPdf(bytes, (path) => {
    const p = String(pageIndex + 1);
    const r = spawnSync('pdftotext', ['-enc', 'UTF-8', '-f', p, '-l', p, path, '-'], {
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`pdftotext 실패: ${r.stderr}`);
    return r.stdout;
  });
}

/**
 * 상자 안 글자(계약 8.3 텍스트 판정): MuPDF 는 글자 사각형 중심, pdf.js 는 텍스트 항목 기준점(줄 왼쪽 아래),
 * Poppler 는 단어 상자 중심이 box(페이지 공간, 쪽 경계 기준 origin) 안인 것을 읽기 순서대로 잇는다.
 */
export async function textInBox(
  engine: Engine,
  bytes: Uint8Array,
  pageIndex: number,
  box: Rect,
  origin: [number, number] = [0, 0],
  margin = 1,
): Promise<string> {
  const inside = (x: number, y: number) =>
    x >= box[0] - margin && x <= box[2] + margin && y >= box[1] - margin && y <= box[3] + margin;
  if (engine === 'mupdf') {
    const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
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
  if (engine === 'pdfjs') {
    const doc = await openPdfjs(bytes);
    try {
      const page = await doc.getPage(pageIndex + 1);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      let out = '';
      for (const i of tc.items) {
        if (!('str' in i)) continue;
        const [x, y] = vp.convertToViewportPoint(
          i.transform[4] as number,
          i.transform[5] as number,
        );
        const h = Math.abs(i.transform[3] as number) || 1;
        if (inside(x + origin[0], y + origin[1] - h * 0.3)) out += i.str;
      }
      return out;
    } finally {
      await doc.close();
    }
  }
  return withTempPdf(bytes, (path) => {
    const p = String(pageIndex + 1);
    const r = spawnSync(
      'pdftotext',
      ['-enc', 'UTF-8', '-cropbox', '-bbox', '-f', p, '-l', p, path, '-'],
      {
        encoding: 'utf8',
      },
    );
    if (r.status !== 0) throw new Error(`pdftotext 실패: ${r.stderr}`);
    let out = '';
    const re =
      /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
    const dec = (t: string) =>
      t
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
    for (const m of r.stdout.matchAll(re)) {
      const cx = (Number(m[1]) + Number(m[3])) / 2 + origin[0];
      const cy = (Number(m[2]) + Number(m[4])) / 2 + origin[1];
      if (inside(cx, cy)) out += dec(m[5]!);
    }
    return out;
  });
}

/** pdf.js marked content 구조: MCID 별로 그 안에서 나온 텍스트. */
export async function pdfjsMarkedText(
  bytes: Uint8Array,
  pageIndex: number,
): Promise<Map<number, string>> {
  const doc = await openPdfjs(bytes);
  try {
    const tc = await (
      await doc.getPage(pageIndex + 1)
    ).getTextContent({ includeMarkedContent: true });
    const out = new Map<number, string>();
    const stack: (number | null)[] = [];
    for (const item of tc.items) {
      if ('type' in item) {
        const it = item as { type: string; id?: string };
        if (it.type === 'beginMarkedContentProps' || it.type === 'beginMarkedContent') {
          // pdf.js id 형식: "<pageRef>_mc<MCID>"(MCID 가 있을 때만).
          const m = it.id ? /mc(\d+)$/.exec(it.id) : null;
          stack.push(m ? Number(m[1]) : null);
        } else if (it.type === 'endMarkedContent') stack.pop();
        continue;
      }
      const mcid = [...stack].reverse().find((v) => v !== null) ?? null;
      if (mcid === null) continue;
      out.set(mcid, (out.get(mcid) ?? '') + (item as { str: string }).str);
    }
    return out;
  } finally {
    await doc.close();
  }
}

/** 텍스트 판정용: 공백류와 기본 무시 문자(Default_Ignorable_Code_Point, 계약 8.3 수정 4)를 지운다. */
export const squash = (s: string) => s.replace(/[\s\p{Default_Ignorable_Code_Point}]+/gu, '');
