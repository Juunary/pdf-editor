// Independent pdf.js check (replaces Day 1 9.3 V3, docs/m0-corpus-recheck.md section 3). Results come from the npm
// `pdfjs-dist` (legacy build, Node), not from the Firefox browser. Extracts text from and renders the edit result with pdf.js to check
// (1) the replaced Korean paragraph is extracted (2) search terms hit (3) the area outside the edit area matches the original
// (4) the ink amount in the edit area is similar to the MuPDF render (detects undisplayed or substituted glyphs).
// core must be imported before mupdf so the WASM heap measurement object is attached (packages/core/src/wasm-module.ts).
import { openPdf } from '@pdf-editor/core';
import * as mupdf from 'mupdf';
import type { Rect } from '@pdf-editor/shared-types';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { GLYPH_DELTA, renderScale } from './corpus-edit.js';
import { inkPixels, renderPage } from './raster.js';

const require = createRequire(import.meta.url);
const PDFJS_ROOT = dirname(require.resolve('pdfjs-dist/package.json'));
pdfjs.GlobalWorkerOptions.workerSrc = join(PDFJS_ROOT, 'legacy/build/pdf.worker.mjs');

export const PDFJS_VERSION = `${pdfjs.version} (${pdfjs.build})`;

const squash = (s: string) => s.replace(/\s+/g, '');
const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1;

export interface PdfjsPageSpec {
  pageIndex: number;
  /** Text that must be in the edit result */
  expectedTexts: string[];
  /** Text that must not be in the edit result (erased original paragraph lines) */
  removedTexts: string[];
  searchTerms: string[];
  /** Edit area (MuPDF page coordinates). Outside it must match the original */
  exclusions: Rect[];
}

export interface PdfjsPair {
  id: string;
  original: string;
  edited: string;
  pages: PdfjsPageSpec[];
  /** Pages that were not edited (render expected to match the original) */
  unchangedPages: number[];
}

interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

interface CanvasLike {
  width: number;
  height: number;
  toBuffer(mime: 'image/png'): Uint8Array;
}

interface CanvasFactoryLike {
  create(
    w: number,
    h: number,
  ): {
    canvas: CanvasLike;
    context: { getImageData(x: number, y: number, w: number, h: number): Rgba };
  };
}

async function open(path: string) {
  return pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
    standardFontDataUrl: `${join(PDFJS_ROOT, 'standard_fonts')}/`,
    cMapUrl: `${join(PDFJS_ROOT, 'cmaps')}/`,
    cMapPacked: true,
    verbosity: pdfjs.VerbosityLevel.WARNINGS,
  }).promise;
}

/**
 * Character multiset (excluding whitespace, sorted) of text items outside the edit area (MuPDF page coordinates). The item anchor is the text matrix
 * origin moved into a scale-1 viewport. Even if reserialization changes how items are split, it is the same if the character composition is the same.
 */
async function outsideChars(
  doc: pdfjs.PDFDocumentProxy,
  pageIndex: number,
  exclusions: Rect[],
  bounds: Rect,
): Promise<string> {
  const page = await doc.getPage(pageIndex + 1);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const chars: string[] = [];
  for (const i of tc.items) {
    if (!('str' in i)) continue;
    const [x, y] = vp.convertToViewportPoint(i.transform[4] as number, i.transform[5] as number);
    const px = x + bounds[0];
    const py = y + bounds[1];
    if (
      exclusions.some((r) => px >= r[0] - 2 && px <= r[2] + 2 && py >= r[1] - 2 && py <= r[3] + 2)
    )
      continue;
    for (const c of i.str) if (!/\s/u.test(c)) chars.push(c);
  }
  return chars.sort().join('');
}

async function pageText(doc: pdfjs.PDFDocumentProxy, pageIndex: number): Promise<string> {
  const tc = await (await doc.getPage(pageIndex + 1)).getTextContent();
  return tc.items.map((i) => ('str' in i ? i.str + (i.hasEOL ? '\n' : '') : '')).join('');
}

async function render(
  doc: pdfjs.PDFDocumentProxy,
  pageIndex: number,
  scale: number,
): Promise<{ rgba: Rgba; png: Uint8Array }> {
  const page = await doc.getPage(pageIndex + 1);
  const vp = page.getViewport({ scale });
  const factory = (doc as unknown as { canvasFactory: CanvasFactoryLike }).canvasFactory;
  // Saving slightly normalizes the page box numbers (measured: 1224.00002 → 1224), so round instead of ceil.
  const { canvas, context } = factory.create(Math.round(vp.width), Math.round(vp.height));
  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport: vp,
  }).promise;
  return {
    rgba: context.getImageData(0, 0, canvas.width, canvas.height),
    png: canvas.toBuffer('image/png'),
  };
}

function inside(x: number, y: number, rects: Rect[]): boolean {
  return rects.some((r) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3]);
}

/** Number of other pixels outside the edit area, number exceeding 96 levels, maximum channel difference (same criterion as corpus-edit GLYPH_DELTA). */
function diffOutside(
  a: Rgba,
  b: Rgba,
  exclude: Rect[],
): { differing: number; strong: number; maxDelta: number } {
  if (a.width !== b.width || a.height !== b.height)
    return { differing: -1, strong: -1, maxDelta: -1 };
  let differing = 0;
  let strong = 0;
  let maxDelta = 0;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      if (inside(x, y, exclude)) continue;
      const i = (y * a.width + x) * 4;
      const d = Math.max(
        Math.abs(a.data[i]! - b.data[i]!),
        Math.abs(a.data[i + 1]! - b.data[i + 1]!),
        Math.abs(a.data[i + 2]! - b.data[i + 2]!),
      );
      if (d > 0) differing++;
      if (d > GLYPH_DELTA) strong++;
      if (d > maxDelta) maxDelta = d;
    }
  return { differing, strong, maxDelta };
}

function inkIn(img: Rgba, rects: Rect[]): number {
  let n = 0;
  for (const r of rects)
    for (let y = Math.max(0, r[1]); y < Math.min(img.height, r[3]); y++)
      for (let x = Math.max(0, r[0]); x < Math.min(img.width, r[2]); x++) {
        const i = (y * img.width + x) * 4;
        if (img.data[i]! < 128 && img.data[i + 1]! < 128 && img.data[i + 2]! < 128) n++;
      }
  return n;
}

const toPx = (r: Rect, bounds: Rect, s: number): Rect => [
  Math.floor((r[0] - bounds[0]) * s) - 2,
  Math.floor((r[1] - bounds[1]) * s) - 2,
  Math.ceil((r[2] - bounds[0]) * s) + 2,
  Math.ceil((r[3] - bounds[1]) * s) + 2,
];

export interface PdfjsPageResult {
  pageIndex: number;
  expectedFound: boolean[];
  removedAbsent: boolean[];
  /** Number of original paragraph lines not classified because they do not appear as is in the original pdf.js extraction */
  removedUnchecked: number;
  searchHits: Record<string, boolean>;
  /** Render difference outside the edit area (observation): number of differing pixels, number exceeding 96 levels, maximum channel difference */
  outsidePx: number;
  outsideStrongPx: number;
  outsideMaxDelta: number;
  /** The character composition of text outside the edit area matches the original (classification criterion) */
  outsideTextSame: boolean;
  /** Edit-area ink (pdf.js) ÷ MuPDF render ink at the same scale */
  inkRatioVsMupdf: number | null;
  png: string;
}

export interface PdfjsPairResult {
  id: string;
  ok: boolean;
  pages: PdfjsPageResult[];
  unchangedPages: { pageIndex: number; diffPx: number }[];
  warnings: string[];
  error?: string;
}

/** For each pair, check text·render with pdf.js. Render PNGs go to outDir/<id>-p<page>.png. */
export async function runPdfjsCheck(
  pairs: PdfjsPair[],
  outDir: string,
): Promise<PdfjsPairResult[]> {
  mkdirSync(outDir, { recursive: true });
  const results: PdfjsPairResult[] = [];
  for (const pair of pairs) {
    const warnings: string[] = [];
    const log = console.log;
    // pdf.js warnings come out as console.log("Warning: …").
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      if (/^Warning:/.test(line)) warnings.push(line);
      else log(...args);
    };
    try {
      const orig = await open(pair.original);
      const edit = await open(pair.edited);
      const mu = openPdf(new Uint8Array(readFileSync(pair.edited)));
      const pages: PdfjsPageResult[] = [];
      for (const spec of pair.pages) {
        const muPage = mu.loadPage(spec.pageIndex);
        const bounds = [...muPage.getBounds()] as Rect;
        const scale = renderScale(bounds);
        const text = squash(await pageText(edit, spec.pageIndex));
        const origText = squash(await pageText(orig, spec.pageIndex));
        const a = await render(orig, spec.pageIndex, scale);
        const b = await render(edit, spec.pageIndex, scale);
        const ex = spec.exclusions.map((r) => toPx(r, bounds, scale));
        const muInk = inkPixels(renderPage(muPage, scale), ex[0]);
        muPage.destroy();
        const png = join(outDir, `${pair.id}-p${spec.pageIndex + 1}.png`);
        writeFileSync(png, b.png);
        pages.push({
          pageIndex: spec.pageIndex,
          expectedFound: spec.expectedTexts.map((t) => text.includes(squash(t))),
          // The same sentence may appear again on the same page, so classify by whether the occurrence count dropped (same approach as corpus-edit).
          // If the MuPDF line string does not appear as is in the original pdf.js extraction (ligature·split differences), only count it without classifying.
          removedAbsent: spec.removedTexts
            .filter((t) => occurrences(origText, squash(t)) > 0)
            .map((t) => occurrences(text, squash(t)) < occurrences(origText, squash(t))),
          removedUnchecked: spec.removedTexts.filter((t) => occurrences(origText, squash(t)) === 0)
            .length,
          searchHits: Object.fromEntries(
            spec.searchTerms.map((t) => [t, text.includes(squash(t))]),
          ),
          ...(() => {
            const d = diffOutside(a.rgba, b.rgba, ex);
            return {
              outsidePx: d.differing,
              outsideStrongPx: d.strong,
              outsideMaxDelta: d.maxDelta,
            };
          })(),
          outsideTextSame:
            (await outsideChars(orig, spec.pageIndex, spec.exclusions, bounds)) ===
            (await outsideChars(edit, spec.pageIndex, spec.exclusions, bounds)),
          inkRatioVsMupdf: muInk > 0 ? inkIn(b.rgba, ex.slice(0, 1)) / muInk : null,
          png,
        });
      }
      const unchangedPages = [];
      for (const p of pair.unchangedPages) {
        const muPage = mu.loadPage(p);
        const scale = renderScale([...muPage.getBounds()] as Rect);
        muPage.destroy();
        const a = await render(orig, p, scale);
        const b = await render(edit, p, scale);
        unchangedPages.push({ pageIndex: p, diffPx: diffOutside(a.rgba, b.rgba, []).differing });
      }
      mu.destroy();
      await orig.loadingTask.destroy();
      await edit.loadingTask.destroy();
      const ok =
        pages.every(
          (p) =>
            p.expectedFound.every(Boolean) &&
            p.removedAbsent.every(Boolean) &&
            Object.values(p.searchHits).every(Boolean) &&
            p.outsideTextSame,
        ) && unchangedPages.every((u) => u.diffPx === 0);
      results.push({ id: pair.id, ok, pages, unchangedPages, warnings: warnings.slice(0, 20) });
    } catch (e) {
      results.push({
        id: pair.id,
        ok: false,
        pages: [],
        unchangedPages: [],
        warnings,
        error: String(e),
      });
    } finally {
      console.log = log;
    }
  }
  return results;
}

/** mupdf page coordinate conversion: PDF user space rectangle → MuPDF page coordinates. */
export function pdfToPageRect(pdfPath: string, pageIndex: number, r: Rect): Rect {
  const doc = openPdf(new Uint8Array(readFileSync(pdfPath)));
  const page = doc.loadPage(pageIndex);
  const t = mupdf.Rect.transform(r, page.getTransform());
  doc.destroy();
  return [Math.min(t[0], t[2]), Math.min(t[1], t[3]), Math.max(t[0], t[2]), Math.max(t[1], t[3])];
}

/** Check specifications for the 3 fixtures/m0 edit results (Day 1, shared XObject, existing Redact). */
export function m0FixturePairs(root: string): PdfjsPair[] {
  const dir = join(root, 'fixtures/m0');
  const target: Rect = [56, 128, 540, 192];
  const targetLines = [
    'This paragraph is the replacement target.',
    'Redaction must remove only this text',
  ];
  const spikeText =
    '새 문단: 원본에 없던 한글 문장을 폴백 폰트(Noto Sans KR)로 임베딩했습니다. 저장 후 다시 열어 검색과 복사가 되는지 확인합니다.';
  const spikeTerms = ['한글', '폴백 폰트', '임베딩', '검색과 복사'];
  return [
    {
      id: 'm0-spike-saved',
      original: join(dir, 'm0-sample.pdf'),
      edited: join(dir, 'm0-spike-saved.pdf'),
      pages: [
        {
          pageIndex: 0,
          expectedTexts: [spikeText],
          removedTexts: targetLines,
          searchTerms: spikeTerms,
          exclusions: [target],
        },
      ],
      unchangedPages: [],
    },
    {
      id: 'm0-shared-xobject-edited',
      original: join(dir, 'm0-shared-xobject.pdf'),
      edited: join(dir, 'm0-shared-xobject-edited.pdf'),
      pages: [
        {
          pageIndex: 0,
          expectedTexts: [
            '공유 Form XObject 의 선택 위치만 복제해 이 문단을 교체했습니다. 다른 위치와 다른 페이지는 원본 그대로입니다.',
            '중첩 Form 교체: 한글 배지',
          ],
          removedTexts: [],
          searchTerms: ['선택 위치만 복제', '한글 배지'],
          // Page 1 B usage location (card BBox 0 0 483 200, origin 56 300) = MuPDF page coordinates [56, 342, 539, 542]
          exclusions: [pdfToPageRect(join(dir, 'm0-shared-xobject.pdf'), 0, [56, 300, 539, 500])],
        },
      ],
      unchangedPages: [1],
    },
    {
      id: 'm0-preexisting-redact-edited',
      original: join(dir, 'm0-preexisting-redact.pdf'),
      edited: join(dir, 'm0-preexisting-redact-edited.pdf'),
      pages: [
        {
          pageIndex: 0,
          expectedTexts: [spikeText, 'Adjacent paragraph: must stay unchanged after the edit.'],
          removedTexts: targetLines,
          searchTerms: spikeTerms,
          exclusions: [target],
        },
      ],
      unchangedPages: [1],
    },
  ];
}

interface CorpusResultFile {
  documents: {
    id: string;
    status: string;
    edit?: {
      save: { ok: boolean };
      otherPages: { pageIndex: number }[];
      paragraphs: {
        pageIndex: number;
        exclusion: Rect;
        searchTerms: string[];
        layout: { text: string } | null;
        reopen: unknown;
      }[];
    };
    analyze?: { paragraphs: { pageIndex: number; lines: { text: string }[] }[] };
  }[];
}

/** Successfully edited documents in out/m0-corpus/corpus-result.json → check specifications. Paragraphs on the same page are grouped into one specification. */
export function corpusPairs(root: string, corpusOut: string): PdfjsPair[] {
  const file = join(corpusOut, 'corpus-result.json');
  const r = JSON.parse(readFileSync(file, 'utf8')) as CorpusResultFile;
  const pairs: PdfjsPair[] = [];
  for (const d of r.documents) {
    if (d.status !== 'ok' || !d.edit?.save.ok) continue;
    const pages = d.edit.paragraphs
      .filter((p) => p.reopen && p.layout)
      .map((p) => {
        const src = d.analyze?.paragraphs.find((a) => a.pageIndex === p.pageIndex);
        return {
          pageIndex: p.pageIndex,
          expectedTexts: [p.layout!.text],
          removedTexts: (src?.lines ?? []).map((l) => l.text).filter((t) => squash(t).length >= 8),
          searchTerms: p.searchTerms,
          exclusions: [p.exclusion],
        };
      });
    pairs.push({
      id: d.id,
      original: join(root, 'fixtures/corpus', `${d.id}.pdf`),
      edited: join(corpusOut, 'edited', `${d.id}.pdf`),
      pages,
      unchangedPages: d.edit.otherPages.map((o) => o.pageIndex),
    });
  }
  return pairs;
}

export async function runPdfjsCli(opts: { root: string; corpusOut: string }): Promise<void> {
  const outDir = join(opts.corpusOut, 'pdfjs');
  let corpus: PdfjsPair[] = [];
  try {
    corpus = corpusPairs(opts.root, opts.corpusOut);
  } catch (e) {
    console.log(`코퍼스 결과 없음(m0 픽스처만 확인): ${String(e)}`);
  }
  const results = await runPdfjsCheck([...m0FixturePairs(opts.root), ...corpus], outDir);
  const summary = {
    date: new Date().toISOString(),
    pdfjs: PDFJS_VERSION,
    note: 'npm pdfjs-dist(legacy 빌드, Node + @napi-rs/canvas) 결과이며 Firefox 브라우저 결과가 아니다',
    pairs: results.length,
    ok: results.filter((r) => r.ok).length,
    results,
  };
  writeFileSync(join(opts.corpusOut, 'pdfjs-result.json'), JSON.stringify(summary, null, 2));
  for (const r of results) {
    console.log(
      `${r.id}: ${r.ok ? '통과' : '불일치'} ` +
        r.pages
          .map(
            (p) =>
              `p${p.pageIndex + 1}[텍스트 ${p.expectedFound.filter(Boolean).length}/${p.expectedFound.length}, ` +
              `밖 텍스트 ${p.outsideTextSame ? '동일' : '다름'}, 밖 ${p.outsidePx}px(>96: ${p.outsideStrongPx}), 잉크비 ${p.inkRatioVsMupdf?.toFixed(2) ?? '-'}]`,
          )
          .join(' ') +
        (r.error ? ` 오류 ${r.error}` : '') +
        (r.warnings.length ? ` 경고 ${r.warnings.length}` : ''),
    );
  }
}
