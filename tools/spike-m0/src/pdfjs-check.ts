// pdf.js 독립 확인(Day 1 9.3 V3 대체, docs/m0-corpus-recheck.md 3절). 브라우저 Firefox 가 아니라 npm
// `pdfjs-dist`(legacy 빌드, Node) 결과다. 편집 결과를 pdf.js 로 텍스트 추출·렌더해
// (1) 교체한 한글 문단이 추출되는지 (2) 검색어가 적중하는지 (3) 편집 영역 밖이 원본과 같은지
// (4) 편집 영역 잉크량이 MuPDF 렌더와 비슷한지(글리프 미표시·대체 글리프 감지)를 본다.
// core 를 mupdf 보다 먼저 import 해야 WASM 힙 측정 객체가 연결된다(packages/core/src/wasm-module.ts).
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
  /** 편집 결과에 있어야 할 텍스트 */
  expectedTexts: string[];
  /** 편집 결과에 없어야 할 텍스트(지운 원 문단 줄) */
  removedTexts: string[];
  searchTerms: string[];
  /** 편집 영역(MuPDF 페이지 좌표). 이 밖은 원본과 같아야 한다 */
  exclusions: Rect[];
}

export interface PdfjsPair {
  id: string;
  original: string;
  edited: string;
  pages: PdfjsPageSpec[];
  /** 편집하지 않은 쪽(원본과 렌더 동일 기대) */
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
 * 편집 영역(MuPDF 페이지 좌표) 밖 텍스트 항목의 글자 다중집합(공백 제외, 정렬). 항목 기준점은 텍스트 행렬
 * 원점을 scale 1 뷰포트로 옮긴 값이다. 재직렬화로 항목 분할이 바뀌어도 글자 구성이 같으면 같다.
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
  // 저장 시 페이지 상자 숫자가 근소하게 정규화되므로(실측: 1224.00002 → 1224) ceil 대신 반올림한다.
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

/** 편집 영역 밖 다른 픽셀 수·96단계 초과 수·최대 채널 차이(corpus-edit GLYPH_DELTA 와 같은 기준). */
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
  /** 원본 pdf.js 추출에 그대로 나오지 않아 판정하지 않은 원 문단 줄 수 */
  removedUnchecked: number;
  searchHits: Record<string, boolean>;
  /** 편집 영역 밖 렌더 차이(관찰): 다른 픽셀 수·96단계 초과 수·최대 채널 차이 */
  outsidePx: number;
  outsideStrongPx: number;
  outsideMaxDelta: number;
  /** 편집 영역 밖 텍스트 글자 구성이 원본과 같음(판정 기준) */
  outsideTextSame: boolean;
  /** 편집 영역 잉크(pdf.js) ÷ 같은 배율 MuPDF 렌더 잉크 */
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

/** 쌍마다 pdf.js 로 텍스트·렌더 확인. 렌더 PNG 는 outDir/<id>-p<쪽>.png. */
export async function runPdfjsCheck(
  pairs: PdfjsPair[],
  outDir: string,
): Promise<PdfjsPairResult[]> {
  mkdirSync(outDir, { recursive: true });
  const results: PdfjsPairResult[] = [];
  for (const pair of pairs) {
    const warnings: string[] = [];
    const log = console.log;
    // pdf.js 경고는 console.log("Warning: …") 로 나온다.
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
          // 같은 쪽에 같은 문장이 또 있을 수 있으므로 등장 횟수가 줄었는지로 판정한다(corpus-edit 와 같은 방식).
          // MuPDF 줄 문자열이 원본 pdf.js 추출에 그대로 없으면(합자·분할 차이) 판정하지 않고 수만 센다.
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

/** mupdf 페이지 좌표 변환: PDF 사용자 공간 사각형 → MuPDF 페이지 좌표. */
export function pdfToPageRect(pdfPath: string, pageIndex: number, r: Rect): Rect {
  const doc = openPdf(new Uint8Array(readFileSync(pdfPath)));
  const page = doc.loadPage(pageIndex);
  const t = mupdf.Rect.transform(r, page.getTransform());
  doc.destroy();
  return [Math.min(t[0], t[2]), Math.min(t[1], t[3]), Math.max(t[0], t[2]), Math.max(t[1], t[3])];
}

/** fixtures/m0 편집 결과 3개(Day 1·공유 XObject·기존 Redact)의 확인 명세. */
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
          // 1쪽 B 사용 위치(카드 BBox 0 0 483 200, 원점 56 300) = MuPDF 페이지 좌표 [56, 342, 539, 542]
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

/** out/m0-corpus/corpus-result.json 의 편집 성공 문서 → 확인 명세. 같은 쪽 문단은 한 명세로 묶는다. */
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
