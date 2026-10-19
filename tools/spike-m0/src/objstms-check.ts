// A3-7: 전체 저장 옵션에 `objstms` 를 더할지 검증(docs/m0-dod-xobject-redact-save.md 3.3·3.6). cli.ts 에서 호출한다.
//
//   node scripts/corpus/fetch-corpus.mjs                 # fixtures/corpus/*.pdf
//   pnpm --filter @pdf-editor/spike-m0 spike:objstms     # → out/m0-dod/objstms/objstms-result.json, summary.md
//     (-- --tmp <dir>: Poppler 쪽 이미지 임시 폴더, 기본 os.tmpdir(). -- --only <id,…>: 입력 id·edit-m0 만)
//
// 같은 문서 상태를 BASE(`garbage=yes,compress`)·OBJSTMS(`garbage=yes,compress,objstms`)로 저장해 비교한다.
// 1. 원본 저장: 코퍼스·fixtures/m0·세대 번호 합성 문서·암호화 변형. 옵션마다 별도 Node 프로세스(저장 시간·힙)
// 2. 편집 후 저장: 코퍼스 문단 교체·M0 Day 1·공유 Form·기존 Redact·암호화 문서. 편집 흐름이 부르는
//    `saveToBuffer(FULL_SAVE_OPTIONS)` 를 가로채 같은 문서 상태에서 두 옵션 출력을 함께 만든다(withDualSave)
// 3. 두 출력 비교: MuPDF 객체 단위(번호·사전·스트림)·쪽 수·쪽별 렌더·텍스트, Poppler·pdf.js 쪽별 렌더·텍스트
// 4. F3 상호작용: 이미지·Form XObject 를 모두 resolve() 한 뒤 저장 → 그냥 저장한 출력과 객체 단위 비교
// 5. 증분 저장: 원본·BASE·OBJSTMS 출력에 주석을 더해 decideSaveMethod 결과로 저장 → 세 엔진 재열기
// core 를 mupdf 보다 먼저 import 해야 WASM 힙 측정 객체가 연결된다(packages/core/src/wasm-module.ts).
import { openPdf, wasmHeapBytes } from '@pdf-editor/core';
import * as mupdf from 'mupdf';
import {
  decideSaveMethod,
  FULL_SAVE_OPTIONS,
  INCREMENTAL_SAVE_OPTIONS,
  redactRegions,
} from '@pdf-editor/pdf-ops';
import type { Rect } from '@pdf-editor/shared-types';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeForEdit, type CorpusManifest } from './corpus-cli.js';
import { runCorpusEdit } from './corpus-edit.js';
import { buildSamplePdf } from './fixture.js';
import { ppmDiff, popplerVersion } from './poppler.js';
import { diffRasters, renderPage, type Raster } from './raster.js';
import { runRedactCase } from './redact-spike.js';
import { captureMupdfLog, runSpike } from './spike.js';
import { runXObjectCase } from './xobject-spike.js';

export const BASE_OPTIONS = 'garbage=yes,compress';
export const OBJSTMS_OPTIONS = 'garbage=yes,compress,objstms';
export type Variant = 'base' | 'objstms';
const VARIANTS: readonly Variant[] = ['base', 'objstms'];
const OPTIONS: Readonly<Record<Variant, string>> = { base: BASE_OPTIONS, objstms: OBJSTMS_OPTIONS };

const OWNER_PASSWORD = 'owner';
const USER_PASSWORD = 'user';
const POPPLER_DPI = 108;
const POPPLER_CHUNK = 20;
const PDFJS_SCALE = 1;

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const squash = (s: string) => s.replace(/\s+/g, '');
const readBytes = (p: string) => new Uint8Array(readFileSync(p));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const mupdfScale = (b: Rect) => Math.min(1.5, 2000 / Math.max(b[2] - b[0], b[3] - b[1]));

// ───────────────────────── 저장 가로채기 ─────────────────────────

const ID_PATTERN = /(\/ID\s*\[\s*<[0-9A-Fa-f]*>\s*<)([0-9A-Fa-f]*)(>\s*\])/;

/**
 * MuPDF 는 저장할 때마다 트레일러 /ID 두 번째 원소(인스턴스 ID)를 새로 만든다(첫 원소는 유지, 실측).
 * 같은 내용인지 바이트로 볼 때는 이 값을 0 으로 바꾼다(같은 길이).
 */
export function normalizeId(bytes: Uint8Array): Uint8Array {
  const text = Buffer.from(bytes).toString('latin1');
  const out = text.replace(
    ID_PATTERN,
    (_m, a: string, id: string, b: string) => a + '0'.repeat(id.length) + b,
  );
  return out === text ? bytes : new Uint8Array(Buffer.from(out, 'latin1'));
}

/**
 * 두 저장 출력의 내용이 같은지: /ID 두 번째 원소를 뺀 바이트가 같으면 같다. 다르면 객체 단위로 본다.
 * 바이트가 달라지는 경우(실측): AES 암호화(문자열·스트림마다 임의 IV), 같은 문서의 objstms 저장 뒤 재저장
 * (컨테이너 번호가 새로 붙고 이전 번호는 xref 의 빈 항목으로 남음).
 */
export function sameOutput(x: Uint8Array, y: Uint8Array, password?: string): boolean {
  if (sameBytes(normalizeId(x), normalizeId(y))) return true;
  const g = compareObjectGraphs(x, y, password);
  return (
    g.differing === 0 &&
    g.missingInObjstms === 0 &&
    Object.keys(g.onlyInObjstms).length === 0 &&
    Object.values(g.trailer).every(Boolean)
  );
}

export interface DualSave {
  base: Uint8Array;
  objstms: Uint8Array;
  /** 같은 문서 상태에서 다시 저장해도 같은 출력(sameOutput, 저장이 문서 상태를 바꾸지 않음) */
  repeatable: boolean;
}

/**
 * `fn` 안에서 `saveToBuffer(FULL_SAVE_OPTIONS)` 호출을 가로채 같은 문서 상태를 두 옵션으로 저장한다.
 * 저장 순서는 first → 다른 옵션 → 두 옵션 다시(반복 확인)이며, 호출자에게는 first 옵션 출력을 돌려준다.
 * 따라서 편집 흐름 자체의 재열기 검증은 first 옵션 출력에 대해 실행된다.
 */
export function withDualSave<T>(
  first: Variant,
  fn: () => T,
  password?: string,
): { value: T; saves: DualSave[] } {
  const proto = mupdf.PDFDocument.prototype;
  const original = proto.saveToBuffer;
  const saves: DualSave[] = [];
  const save = (doc: mupdf.PDFDocument, v: Variant) => {
    const buf = original.call(doc, OPTIONS[v]);
    const bytes = buf.asUint8Array().slice();
    buf.destroy();
    return bytes;
  };
  const second: Variant = first === 'base' ? 'objstms' : 'base';
  proto.saveToBuffer = function (this: mupdf.PDFDocument, options: unknown) {
    if (options !== FULL_SAVE_OPTIONS) return original.call(this, options);
    const a = save(this, first);
    const b = save(this, second);
    const repeatable =
      sameOutput(a, save(this, first), password) && sameOutput(b, save(this, second), password);
    saves.push({
      base: first === 'base' ? a : b,
      objstms: first === 'base' ? b : a,
      repeatable,
    });
    return original.call(this, OPTIONS[first]);
  };
  try {
    return { value: fn(), saves };
  } finally {
    proto.saveToBuffer = original;
  }
}

// ───────────────────────── 파일 구조 ─────────────────────────

export interface FileShape {
  bytes: number;
  header: string;
  /** 마지막 startxref 가 가리키는 구간: xref 표 또는 xref 스트림 */
  lastXref: 'table' | 'stream' | 'unknown';
  /** %%EOF 수(증분 구간 수 + 1) */
  eofMarkers: number;
}

export function fileShape(bytes: Uint8Array): FileShape {
  const head = Buffer.from(bytes.subarray(0, 16)).toString('latin1');
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 1024))).toString('latin1');
  const m = [...tail.matchAll(/startxref\s+(\d+)/g)].at(-1);
  let lastXref: FileShape['lastXref'] = 'unknown';
  if (m) {
    const at = Buffer.from(bytes.subarray(Number(m[1]), Number(m[1]) + 32)).toString('latin1');
    lastXref = /^\s*xref/.test(at)
      ? 'table'
      : /^\s*\d+\s+\d+\s+obj/.test(at)
        ? 'stream'
        : 'unknown';
  }
  const all = Buffer.from(bytes).toString('latin1');
  return {
    bytes: bytes.byteLength,
    header: head.match(/%PDF-\d\.\d/)?.[0] ?? '',
    lastXref,
    eofMarkers: all.split('%%EOF').length - 1,
  };
}

function open(bytes: Uint8Array, password?: string, inputMode: 'buffer' | 'stream' = 'buffer') {
  const doc = openPdf(bytes, { inputMode });
  if (doc.needsPassword() && !doc.authenticatePassword(password ?? '')) {
    doc.destroy();
    throw new Error('비밀번호 인증 실패');
  }
  return doc;
}

// ───────────────────────── 객체 단위 비교 ─────────────────────────

interface ObjectInfo {
  type: string;
  dict: string;
  stream: string | null;
}

function objectInfo(doc: mupdf.PDFDocument, num: number, decode: boolean): ObjectInfo | null {
  const ref = doc.newIndirect(num);
  const obj = ref.resolve();
  try {
    if (obj.isNull()) return null;
    let stream: string | null = null;
    if (ref.isStream()) {
      const buf = decode ? ref.readStream() : ref.readRawStream();
      stream = sha256(buf.asUint8Array());
      buf.destroy();
    }
    const t = obj.isDictionary() ? obj.get('Type') : null;
    // XRef 스트림 사전의 /ID 두 번째 원소는 저장마다 바뀐다(normalizeId)
    const dict = obj.toString().replace(ID_PATTERN, '$1…$3');
    return { type: t?.isName() ? t.asName() : '', dict, stream };
  } finally {
    if (!obj.isNull()) obj.destroy();
    ref.destroy();
  }
}

/** 저장 구조용 컨테이너(객체 스트림·xref 스트림). 저장마다 새 번호를 받으므로 내용 비교에서 뺀다. */
const CONTAINER_TYPES: ReadonlySet<string> = new Set(['ObjStm', 'XRef']);

export interface GraphCompare {
  /** 사용 중 객체 수(컨테이너 제외) */
  objects: Record<Variant, number>;
  /** 컨테이너(ObjStm·XRef) 수 */
  containers: Record<Variant, number>;
  /** 두 출력에 모두 있고 사전 또는 스트림이 다른 객체 수(판정: 0) */
  differing: number;
  /** BASE 에만 있는 객체 수(판정: 0) */
  missingInObjstms: number;
  /** OBJSTMS 에만 있는 객체의 /Type 별 수(판정: 없음) */
  onlyInObjstms: Record<string, number>;
  /** 트레일러 /Root·/Info·/ID 첫 원소·/Encrypt 동일 */
  trailer: Record<'root' | 'info' | 'id' | 'encrypt', boolean>;
  /** 암호화 문서: /Encrypt 사전이 객체 스트림 밖(트레일러 직접 사전 또는 최상위 간접 객체)에 있음 */
  encryptTopLevel: boolean | null;
  samples: string[];
}

/**
 * 같은 객체 번호끼리 사전 문자열과 스트림(원시 바이트, 암호화 문서는 복호 내용) 해시를 비교한다.
 * 컨테이너(ObjStm·XRef)는 따로 센다. 두 인자는 BASE·OBJSTMS 외에 같은 옵션의 두 출력이어도 된다.
 */
export function compareObjectGraphs(
  base: Uint8Array,
  objstms: Uint8Array,
  password?: string,
): GraphCompare {
  const a = open(base, password);
  const b = open(objstms, password);
  try {
    const encrypted = !a.getTrailer().get('Encrypt').isNull();
    const n = Math.max(a.countObjects(), b.countObjects());
    const out: GraphCompare = {
      objects: { base: 0, objstms: 0 },
      containers: { base: 0, objstms: 0 },
      differing: 0,
      missingInObjstms: 0,
      onlyInObjstms: {},
      trailer: { root: false, info: false, id: false, encrypt: false },
      encryptTopLevel: null,
      samples: [],
    };
    for (let num = 1; num < n; num++) {
      let x = num < a.countObjects() ? objectInfo(a, num, encrypted) : null;
      let y = num < b.countObjects() ? objectInfo(b, num, encrypted) : null;
      if (x && CONTAINER_TYPES.has(x.type)) {
        out.containers.base++;
        x = null;
      }
      if (y && CONTAINER_TYPES.has(y.type)) {
        out.containers.objstms++;
        y = null;
      }
      if (x) out.objects.base++;
      if (y) out.objects.objstms++;
      if (x && !y) {
        out.missingInObjstms++;
        if (out.samples.length < 8) out.samples.push(`${num}: OBJSTMS 에 없음`);
      } else if (!x && y) {
        out.onlyInObjstms[y.type] = (out.onlyInObjstms[y.type] ?? 0) + 1;
      } else if (x && y && (x.dict !== y.dict || x.stream !== y.stream)) {
        out.differing++;
        if (out.samples.length < 8)
          out.samples.push(`${num}: ${x.dict.slice(0, 80)} ≠ ${y.dict.slice(0, 80)}`);
      }
    }
    const ta = a.getTrailer();
    const tb = b.getTrailer();
    for (const [k, key] of [
      ['root', 'Root'],
      ['info', 'Info'],
      ['id', 'ID'],
      ['encrypt', 'Encrypt'],
    ] as const) {
      const pick = (t: mupdf.PDFObject) => {
        const v = t.get(key);
        return key === 'ID' && v.isArray() ? v.get(0) : v;
      };
      out.trailer[k] = pick(ta).toString() === pick(tb).toString();
    }
    if (encrypted) {
      const enc = tb.get('Encrypt');
      const num = enc.isIndirect() ? enc.asIndirect() : -1;
      out.encryptTopLevel =
        !enc.isIndirect() ||
        new RegExp(`(^|[\\r\\n])${num} 0 obj`).test(Buffer.from(objstms).toString('latin1'));
    }
    return out;
  } finally {
    a.destroy();
    b.destroy();
  }
}

// ───────────────────────── 엔진별 쪽 비교 ─────────────────────────

export interface EngineCompare {
  pages: Partial<Record<'orig' | Variant, number>>;
  /** BASE·OBJSTMS 렌더가 다른 쪽 수(판정: 0)와 최대 다른 픽셀 수 */
  renderDiffPages: number;
  renderDiffMaxPx: number;
  /** BASE·OBJSTMS 텍스트가 다른 쪽 수(판정: 0) */
  textDiffPages: number;
  /** 관찰: 원본 대비 렌더가 다른 쪽 수(원본이 있을 때) */
  origDiffPages: Partial<Record<Variant, number>>;
  /** 엔진 경고·오류 줄 수 */
  messages: Partial<Record<'orig' | Variant, number>>;
  error?: string;
}

function emptyEngine(): EngineCompare {
  return {
    pages: {},
    renderDiffPages: 0,
    renderDiffMaxPx: 0,
    textDiffPages: 0,
    origDiffPages: {},
    messages: {},
  };
}

function rasterDiff(a: Raster, b: Raster): number {
  if (a.width !== b.width || a.height !== b.height) return -1;
  if (Buffer.from(a.pixels.buffer).equals(Buffer.from(b.pixels.buffer))) return 0;
  return diffRasters(a, b).differing;
}

function mupdfCompare(
  files: Partial<Record<'orig' | Variant, Uint8Array>>,
  password?: string,
): EngineCompare {
  const r = emptyEngine();
  const logs: Record<string, string[]> = {};
  const docs = new Map<'orig' | Variant, mupdf.PDFDocument>();
  const logged = <T>(k: string, fn: () => T): T =>
    captureMupdfLog((m) => {
      try {
        return fn();
      } finally {
        (logs[k] ??= []).push(...m);
      }
    });
  try {
    for (const [k, bytes] of Object.entries(files) as ['orig' | Variant, Uint8Array][]) {
      const doc = logged(k, () => open(bytes, password));
      docs.set(k, doc);
      r.pages[k] = doc.countPages();
    }
    const n = Math.max(...Object.values(r.pages));
    for (let i = 0; i < n; i++) {
      const raster = new Map<string, Raster>();
      const text = new Map<string, string>();
      for (const [k, doc] of docs) {
        if (i >= doc.countPages()) continue;
        logged(k, () => {
          const page = doc.loadPage(i);
          raster.set(k, renderPage(page, mupdfScale([...page.getBounds()] as Rect)));
          text.set(k, page.toStructuredText('preserve-whitespace').asText());
          page.destroy();
        });
      }
      const a = raster.get('base');
      const b = raster.get('objstms');
      const d = a && b ? rasterDiff(a, b) : -1;
      if (d !== 0) r.renderDiffPages++;
      r.renderDiffMaxPx = Math.max(r.renderDiffMaxPx, d);
      if (text.get('base') !== text.get('objstms')) r.textDiffPages++;
      const o = raster.get('orig');
      if (o)
        for (const v of VARIANTS) {
          const x = raster.get(v);
          const same = x !== undefined && rasterDiff(o, x) === 0;
          r.origDiffPages[v] = (r.origDiffPages[v] ?? 0) + (same ? 0 : 1);
        }
    }
  } catch (e) {
    r.error = String(e);
  } finally {
    for (const d of docs.values()) d.destroy();
  }
  for (const k of Object.keys(files)) r.messages[k as Variant] = logs[k]?.length ?? 0;
  return r;
}

const pwArgs = (password?: string) => (password ? ['-upw', password] : []);
const popplerErrors = (stderr: string) =>
  stderr.split('\n').filter((l) => /error|warning/i.test(l)).length;

function popplerInfo(pdf: string, password?: string): { pages: number; stderr: string } {
  const r = spawnSync('pdfinfo', [...pwArgs(password), pdf], { encoding: 'utf8' });
  return { pages: Number(r.stdout.match(/^Pages:\s+(\d+)/m)?.[1] ?? -1), stderr: r.stderr };
}

/** 쪽 범위 렌더 → 쪽 번호별 PPM 파일 경로. */
function popplerChunk(
  pdf: string,
  first: number,
  last: number,
  dir: string,
  tag: string,
  password?: string,
): { files: Map<number, string>; stderr: string } {
  const r = spawnSync(
    'pdftoppm',
    [
      '-r',
      String(POPPLER_DPI),
      '-f',
      String(first),
      '-l',
      String(last),
      ...pwArgs(password),
      pdf,
      join(dir, tag),
    ],
    { encoding: 'utf8' },
  );
  const files = new Map<number, string>();
  for (const f of readdirSync(dir)) {
    const m = f.match(new RegExp(`^${tag}-(\\d+)\\.ppm$`));
    if (m) files.set(Number(m[1]), join(dir, f));
  }
  return { files, stderr: r.stderr };
}

function popplerCompare(
  files: Partial<Record<'orig' | Variant, string>>,
  tmpRoot: string,
  password?: string,
): EngineCompare {
  const r = emptyEngine();
  const dir = mkdtempSync(join(tmpRoot, 'objstms-poppler-'));
  try {
    const stderr: Record<string, string> = {};
    for (const [k, pdf] of Object.entries(files)) {
      const info = popplerInfo(pdf, password);
      r.pages[k as Variant] = info.pages;
      stderr[k] = info.stderr;
    }
    const text: Record<string, string[]> = {};
    for (const v of VARIANTS) {
      const t = spawnSync('pdftotext', ['-enc', 'UTF-8', ...pwArgs(password), files[v]!, '-'], {
        encoding: 'utf8',
        maxBuffer: 1 << 28,
      });
      text[v] = t.stdout.split('\f');
      stderr[v] += t.stderr;
    }
    const n = Math.max(...Object.values(r.pages));
    for (let i = 0; i < n; i++) if (text.base![i] !== text.objstms![i]) r.textDiffPages++;
    for (let first = 1; first <= n; first += POPPLER_CHUNK) {
      const last = Math.min(n, first + POPPLER_CHUNK - 1);
      const chunk = new Map<string, Map<number, string>>();
      for (const [k, pdf] of Object.entries(files)) {
        const c = popplerChunk(pdf, first, last, dir, k, password);
        chunk.set(k, c.files);
        stderr[k] += c.stderr;
      }
      for (let p = first; p <= last; p++) {
        const read = (k: string) => {
          const f = chunk.get(k)?.get(p);
          return f ? readFileSync(f) : null;
        };
        const a = read('base');
        const b = read('objstms');
        const d = a && b ? (a.equals(b) ? 0 : ppmDiff(a, b)) : -1;
        if (d !== 0) r.renderDiffPages++;
        r.renderDiffMaxPx = Math.max(r.renderDiffMaxPx, d);
        const o = read('orig');
        if (o)
          for (const v of VARIANTS) {
            const x = read(v);
            const same = x !== null && o.equals(x);
            r.origDiffPages[v] = (r.origDiffPages[v] ?? 0) + (same ? 0 : 1);
          }
      }
      for (const f of readdirSync(dir)) rmSync(join(dir, f));
    }
    for (const [k, s] of Object.entries(stderr)) r.messages[k as Variant] = popplerErrors(s);
  } catch (e) {
    r.error = String(e);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return r;
}

const require = createRequire(import.meta.url);
const PDFJS_ROOT = dirname(require.resolve('pdfjs-dist/package.json'));
pdfjs.GlobalWorkerOptions.workerSrc = join(PDFJS_ROOT, 'legacy/build/pdf.worker.mjs');

interface CanvasFactoryLike {
  create(
    w: number,
    h: number,
  ): {
    canvas: { width: number; height: number };
    context: {
      getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
    };
  };
}

function pdfjsOpen(path: string, password?: string) {
  return pdfjs.getDocument({
    data: readBytes(path),
    ...(password ? { password } : {}),
    standardFontDataUrl: `${join(PDFJS_ROOT, 'standard_fonts')}/`,
    cMapUrl: `${join(PDFJS_ROOT, 'cmaps')}/`,
    cMapPacked: true,
    verbosity: pdfjs.VerbosityLevel.WARNINGS,
  }).promise;
}

async function pdfjsPage(
  doc: pdfjs.PDFDocumentProxy,
  i: number,
): Promise<{ pixels: Uint8ClampedArray; w: number; h: number; text: string }> {
  const page = await doc.getPage(i + 1);
  const vp = page.getViewport({ scale: PDFJS_SCALE });
  const factory = (doc as unknown as { canvasFactory: CanvasFactoryLike }).canvasFactory;
  const { canvas, context } = factory.create(Math.round(vp.width), Math.round(vp.height));
  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport: vp,
  }).promise;
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const tc = await page.getTextContent();
  const text = tc.items.map((t) => ('str' in t ? t.str + (t.hasEOL ? '\n' : '') : '')).join('');
  page.cleanup();
  return { pixels, w: canvas.width, h: canvas.height, text };
}

async function pdfjsCompare(
  files: Record<Variant, string>,
  password?: string,
): Promise<EngineCompare> {
  const r = emptyEngine();
  const warnings: Record<string, number> = { base: 0, objstms: 0 };
  let current: Variant = 'base';
  const log = console.log;
  // pdf.js 경고는 console.log("Warning: …") 로 나온다.
  console.log = (...args: unknown[]) => {
    if (/^Warning:/.test(args.map(String).join(' ')))
      warnings[current] = (warnings[current] ?? 0) + 1;
    else log(...args);
  };
  const docs: Partial<Record<Variant, pdfjs.PDFDocumentProxy>> = {};
  try {
    for (const v of VARIANTS) {
      current = v;
      docs[v] = await pdfjsOpen(files[v], password);
      r.pages[v] = docs[v].numPages;
    }
    const n = Math.max(r.pages.base!, r.pages.objstms!);
    for (let i = 0; i < n; i++) {
      current = 'base';
      const a = i < r.pages.base! ? await pdfjsPage(docs.base!, i) : null;
      current = 'objstms';
      const b = i < r.pages.objstms! ? await pdfjsPage(docs.objstms!, i) : null;
      let d = -1;
      if (a && b && a.w === b.w && a.h === b.h) {
        d = 0;
        if (!Buffer.from(a.pixels.buffer).equals(Buffer.from(b.pixels.buffer)))
          for (let p = 0; p < a.pixels.length; p += 4)
            if (
              a.pixels[p] !== b.pixels[p] ||
              a.pixels[p + 1] !== b.pixels[p + 1] ||
              a.pixels[p + 2] !== b.pixels[p + 2]
            )
              d++;
      }
      if (d !== 0) r.renderDiffPages++;
      r.renderDiffMaxPx = Math.max(r.renderDiffMaxPx, d);
      if (a?.text !== b?.text) r.textDiffPages++;
    }
  } catch (e) {
    r.error = String(e);
  } finally {
    console.log = log;
    for (const d of Object.values(docs)) await d.loadingTask.destroy();
  }
  r.messages = warnings;
  return r;
}

// ───────────────────────── 자식 작업 ─────────────────────────

interface SaveSpec {
  input: string;
  variant: Variant;
  password?: string;
  output: string;
}

export interface SaveOutput {
  variant: Variant;
  options: string;
  /** 3회(매번 새로 열기) 저장 시간 ms */
  saveMs: number[];
  /** 첫 저장 직후 WASM 선형 메모리(프로세스 피크) */
  wasmHeapBytes: number | null;
  shape: FileShape;
  pages: number;
  version: number;
  canBeSavedIncrementally: boolean;
  messages: number;
}

function runSaveTask(spec: SaveSpec): SaveOutput {
  const input = readBytes(spec.input);
  const saveMs: number[] = [];
  let out: Uint8Array | null = null;
  let heap: number | null = null;
  for (let i = 0; i < 3; i++) {
    // 제품 열기 경로(PdfSession.open 기본 = Stream 입력)
    const doc = open(input, spec.password, 'stream');
    const t0 = performance.now();
    const buf = doc.saveToBuffer(OPTIONS[spec.variant]);
    saveMs.push(performance.now() - t0);
    if (i === 0) {
      heap = wasmHeapBytes();
      out = buf.asUint8Array().slice();
    }
    buf.destroy();
    doc.destroy();
  }
  writeFileSync(spec.output, out!);
  return captureMupdfLog((m) => {
    const re = open(out!, spec.password);
    const r: SaveOutput = {
      variant: spec.variant,
      options: OPTIONS[spec.variant],
      saveMs,
      wasmHeapBytes: heap,
      shape: fileShape(out!),
      pages: re.countPages(),
      version: re.getVersion(),
      canBeSavedIncrementally: re.canBeSavedIncrementally(),
      messages: 0,
    };
    re.destroy();
    r.messages = m.length;
    return r;
  });
}

interface CompareSpec {
  orig?: string;
  base: string;
  objstms: string;
  password?: string;
  tmp: string;
}

export interface CompareOutput {
  shape: Record<Variant, FileShape>;
  graph: GraphCompare | { error: string };
  mupdf: EngineCompare;
  poppler: EngineCompare | null;
}

function runCompareTask(spec: CompareSpec): CompareOutput {
  const bytes = {
    ...(spec.orig ? { orig: readBytes(spec.orig) } : {}),
    base: readBytes(spec.base),
    objstms: readBytes(spec.objstms),
  };
  let graph: CompareOutput['graph'];
  try {
    graph = compareObjectGraphs(bytes.base, bytes.objstms, spec.password);
  } catch (e) {
    graph = { error: String(e) };
  }
  return {
    shape: { base: fileShape(bytes.base), objstms: fileShape(bytes.objstms) },
    graph,
    mupdf: mupdfCompare(bytes, spec.password),
    poppler: popplerVersion()
      ? popplerCompare(
          { ...(spec.orig ? { orig: spec.orig } : {}), base: spec.base, objstms: spec.objstms },
          spec.tmp,
          spec.password,
        )
      : null,
  };
}

interface ResolveSpec {
  input: string;
  plain: string;
  password?: string;
}

export interface ResolveOutput {
  /** resolve() 한 이미지·Form XObject 수 */
  resolved: { images: number; forms: number };
  /** resolve() 후 OBJSTMS 저장 vs 그냥 OBJSTMS 저장: 객체 단위 비교 */
  vsPlain: GraphCompare | { error: string };
  /** resolve() 후 저장 출력에서 스트림이 아닌 이미지 XObject 수(판정: 0) */
  lostImages: number;
  /** 대조: 같은 resolve() 후 `garbage=compact,compress` 저장에서 스트림이 아닌 이미지 XObject 수 */
  compactLostImages: number;
}

/** 쪽 Resources(상속 포함)의 XObject 와 Form 안 XObject 를 한 단계 더 resolve() 한다. 래퍼는 저장까지 유지. */
function resolveXObjects(doc: mupdf.PDFDocument, keep: mupdf.PDFObject[]) {
  const count = { images: 0, forms: 0 };
  const seen = new Set<number>();
  const visit = (xobjects: mupdf.PDFObject, depth: number) => {
    if (!xobjects.isDictionary()) return;
    xobjects.forEach((v) => {
      if (!v.isIndirect() || seen.has(v.asIndirect())) return;
      seen.add(v.asIndirect());
      const subtype = v.get('Subtype');
      const name = subtype.isName() ? subtype.asName() : '';
      const obj = v.resolve();
      keep.push(obj);
      if (name === 'Image') count.images++;
      if (name === 'Form') {
        count.forms++;
        if (depth < 2) visit(obj.get('Resources').get('XObject'), depth + 1);
      }
    });
  };
  for (let i = 0; i < doc.countPages(); i++) {
    let node: mupdf.PDFObject = doc.findPage(i);
    while (node.get('Resources').isNull() && !node.get('Parent').isNull())
      node = node.get('Parent');
    visit(node.get('Resources').get('XObject'), 1);
  }
  return count;
}

function imageStreamsLost(bytes: Uint8Array, password?: string): number {
  const doc = open(bytes, password);
  let lost = 0;
  for (let num = 1; num < doc.countObjects(); num++) {
    const ref = doc.newIndirect(num);
    const sub = ref.get('Subtype');
    if (sub.isName() && sub.asName() === 'Image' && !ref.isStream()) lost++;
    ref.destroy();
  }
  doc.destroy();
  return lost;
}

function runResolveTask(spec: ResolveSpec): ResolveOutput {
  const input = readBytes(spec.input);
  const saveAfterResolve = (options: string) =>
    captureMupdfLog(() => {
      const doc = open(input, spec.password);
      const keep: mupdf.PDFObject[] = [];
      const resolved = resolveXObjects(doc, keep);
      const buf = doc.saveToBuffer(options);
      const bytes = buf.asUint8Array().slice();
      buf.destroy();
      for (const o of keep) o.destroy();
      doc.destroy();
      return { resolved, bytes };
    });
  const b = saveAfterResolve(OBJSTMS_OPTIONS);
  const c = saveAfterResolve('garbage=compact,compress');
  let vsPlain: ResolveOutput['vsPlain'];
  try {
    vsPlain = compareObjectGraphs(readBytes(spec.plain), b.bytes, spec.password);
  } catch (e) {
    vsPlain = { error: String(e) };
  }
  return {
    resolved: b.resolved,
    vsPlain,
    lostImages: captureMupdfLog(() => imageStreamsLost(b.bytes, spec.password)),
    compactLostImages: captureMupdfLog(() => imageStreamsLost(c.bytes, spec.password)),
  };
}

interface IncrementalSpec {
  inputs: Record<'orig' | Variant, string>;
  password?: string;
  outDir: string;
  id: string;
}

/**
 * 증분 저장 사례. orig·base·objstms = 그 파일을 열어 주석 추가 후 저장.
 * session-base·session-objstms = 원본을 열어 그 옵션으로 전체 저장한 뒤(결과는 버림) 같은 문서에 주석을 더해
 * 저장(제품 PdfSession 은 저장 후에도 같은 문서를 계속 쓴다).
 */
export type IncrementalKey = 'orig' | Variant | 'session-base' | 'session-objstms';

export interface IncrementalCase {
  canBeSavedIncrementally: boolean;
  method: string;
  options: string;
  error?: string;
  appendedBytes: number;
  /** 증분 저장이면 원래 바이트가 그대로 앞에 남음 */
  prefixKept: boolean;
  shape: FileShape | null;
  /** 덧붙인 구간의 객체 번호 */
  appendedObjects: number[];
  reopen: {
    mupdf: { pages: number; versions: number; notes: number; messages: number } | null;
    poppler: { pages: number; errors: number } | null;
    pdfjs: { pages: number; notes: number; warnings: number; error?: string } | null;
  };
}

export interface IncrementalOutput {
  cases: Partial<Record<IncrementalKey, IncrementalCase>>;
  /** 원본에 `incremental,objstms` 로 저장: 성공 여부·`incremental` 출력과 같은지(sameOutput) */
  incrementalObjstms: { ok: boolean; error?: string; sameAsIncremental: boolean | null };
  /** 1쪽 MuPDF 렌더 다른 픽셀 수: base vs objstms, session-base vs session-objstms */
  page1DiffPx: { files: number | null; session: number | null };
  /** 원본 파일의 Poppler 경고·오류 줄 수(pdfinfo + 1쪽 렌더). 재열기 판정 기준선 */
  popplerBaselineErrors: number | null;
}

const NOTE = 'A3-7 incremental check';

function addNoteAndSave(
  bytes: Uint8Array,
  password?: string,
  options?: string,
  fullSaveFirst?: string,
) {
  return captureMupdfLog(() => {
    const doc = open(bytes, password, 'stream');
    if (fullSaveFirst) doc.saveToBuffer(fullSaveFirst).destroy();
    const can = doc.canBeSavedIncrementally();
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const annot = page.createAnnotation('Text');
    annot.setRect([10, 10, 30, 30]);
    annot.setContents(NOTE);
    annot.update();
    page.destroy();
    const decision = decideSaveMethod(['annotation'], doc.canBeSavedIncrementally());
    const used = options ?? decision.options;
    const buf = doc.saveToBuffer(used);
    const out = buf.asUint8Array().slice();
    buf.destroy();
    doc.destroy();
    return { can, decision, used, out };
  });
}

/** Poppler: 쪽 수와 pdfinfo·1쪽 렌더의 경고·오류 줄 수. */
function reopenPoppler(file: string, c: IncrementalCase, password?: string): void {
  const info = popplerInfo(file, password);
  const ppm = spawnSync('pdftoppm', ['-r', '36', '-f', '1', '-l', '1', ...pwArgs(password), file], {
    encoding: 'buffer',
    maxBuffer: 1 << 28,
  });
  c.reopen.poppler = {
    pages: info.pages,
    errors: popplerErrors(info.stderr + ppm.stderr.toString('utf8')),
  };
}

async function reopenChecks(file: string, out: Uint8Array, c: IncrementalCase, password?: string) {
  c.reopen.mupdf = captureMupdfLog((m) => {
    const re = open(out, password);
    const page = re.loadPage(0) as mupdf.PDFPage;
    const notes = page
      .getAnnotations()
      .filter((a) => a.getType() === 'Text' && a.getContents() === NOTE).length;
    renderPage(page, 0.5);
    page.destroy();
    const r = { pages: re.countPages(), versions: re.countVersions(), notes, messages: 0 };
    re.destroy();
    r.messages = m.length;
    return r;
  });
  if (popplerVersion()) reopenPoppler(file, c, password);
  let warnings = 0;
  const log = console.log;
  console.log = (...args: unknown[]) => {
    if (/^Warning:/.test(args.map(String).join(' '))) warnings++;
    else log(...args);
  };
  try {
    const doc = await pdfjsOpen(file, password);
    const page = await doc.getPage(1);
    const notes = (await page.getAnnotations()).filter(
      (a: { subtype?: string; contentsObj?: { str?: string } }) =>
        a.subtype === 'Text' && a.contentsObj?.str === NOTE,
    ).length;
    c.reopen.pdfjs = { pages: doc.numPages, notes, warnings };
    await doc.loadingTask.destroy();
  } catch (e) {
    c.reopen.pdfjs = { pages: -1, notes: 0, warnings, error: String(e) };
  } finally {
    console.log = log;
  }
}

async function runIncrementalTask(spec: IncrementalSpec): Promise<IncrementalOutput> {
  const result: IncrementalOutput = {
    cases: {},
    incrementalObjstms: { ok: false, sameAsIncremental: null },
    page1DiffPx: { files: null, session: null },
    popplerBaselineErrors: null,
  };
  if (popplerVersion()) {
    const c = { reopen: {} } as IncrementalCase;
    reopenPoppler(spec.inputs.orig, c, spec.password);
    result.popplerBaselineErrors = c.reopen.poppler?.errors ?? null;
  }
  const outputs: Partial<Record<IncrementalKey, Uint8Array>> = {};
  const plan: [IncrementalKey, string, string | undefined][] = [
    ['orig', spec.inputs.orig, undefined],
    ['base', spec.inputs.base, undefined],
    ['objstms', spec.inputs.objstms, undefined],
    ['session-base', spec.inputs.orig, BASE_OPTIONS],
    ['session-objstms', spec.inputs.orig, OBJSTMS_OPTIONS],
  ];
  for (const [k, path, fullSaveFirst] of plan) {
    const bytes = readBytes(path);
    const c: IncrementalCase = {
      canBeSavedIncrementally: false,
      method: '',
      options: '',
      appendedBytes: 0,
      prefixKept: false,
      shape: null,
      appendedObjects: [],
      reopen: { mupdf: null, poppler: null, pdfjs: null },
    };
    result.cases[k] = c;
    try {
      const s = addNoteAndSave(bytes, spec.password, undefined, fullSaveFirst);
      const prefixKept =
        s.out.length >= bytes.length && sameBytes(s.out.subarray(0, bytes.length), bytes);
      Object.assign(c, {
        canBeSavedIncrementally: s.can,
        method: s.decision.method,
        options: s.used,
        appendedBytes: s.out.length - bytes.length,
        prefixKept,
        shape: fileShape(s.out),
        appendedObjects: prefixKept
          ? [
              ...Buffer.from(s.out.subarray(bytes.length))
                .toString('latin1')
                .matchAll(/(?:^|[\r\n])(\d+) \d+ obj/g),
            ].map((m) => Number(m[1]))
          : [],
      });
      outputs[k] = s.out;
      const file = join(spec.outDir, `${spec.id}.${k}.inc.pdf`);
      writeFileSync(file, s.out);
      await reopenChecks(file, s.out, c, spec.password);
    } catch (e) {
      c.error = String(e);
    }
  }
  try {
    const orig = readBytes(spec.inputs.orig);
    const s = addNoteAndSave(orig, spec.password, `${INCREMENTAL_SAVE_OPTIONS},objstms`);
    result.incrementalObjstms = {
      ok: true,
      sameAsIncremental: outputs.orig ? sameOutput(s.out, outputs.orig, spec.password) : null,
    };
  } catch (e) {
    result.incrementalObjstms = { ok: false, error: String(e), sameAsIncremental: null };
  }
  const page1 = (b: Uint8Array) => {
    const d = open(b, spec.password);
    const p = d.loadPage(0);
    const x = renderPage(p, 1);
    p.destroy();
    d.destroy();
    return x;
  };
  const diff = (x?: Uint8Array, y?: Uint8Array) =>
    x && y ? captureMupdfLog(() => rasterDiff(page1(x), page1(y))) : null;
  result.page1DiffPx = {
    files: diff(outputs.base, outputs.objstms),
    session: diff(outputs['session-base'], outputs['session-objstms']),
  };
  return result;
}

// ── 편집 후 저장 ──

/** 결과 객체에서 옵션·시간·바이트 수처럼 저장 옵션에 따라 달라지는 값을 뺀다(두 실행 판정 비교용). */
function stripVolatile(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripVolatile);
  if (v instanceof Uint8Array) return undefined;
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .filter(
          ([k]) => !/(Ms|^ms)$|^marks$|[bB]ytes|^options$|^heap$|^mupdfMessages$|[sS]ha256/.test(k),
        )
        .map(([k, x]) => [k, stripVolatile(x)]),
    );
  return v;
}

export interface EditCaseOutput {
  name: string;
  /** 저장 호출 수(두 실행 각각) */
  saves: [number, number];
  /** 같은 문서 상태 재저장 바이트 동일(두 실행 모두) */
  repeatable: boolean;
  /** 실행 1(BASE 먼저)·실행 2(OBJSTMS 먼저)의 같은 옵션 출력 동일(sameOutput): 편집 결정적 + 저장 순서 무관 */
  crossRunSame: boolean;
  /** 편집 흐름의 재열기 판정(옵션·시간·바이트 제외)이 BASE 출력·OBJSTMS 출력에서 같음 */
  verdictSame: boolean;
  /** 편집 흐름이 OBJSTMS 출력에서 낸 판정 요약 */
  objstmsVerdict: unknown;
  files: Record<Variant, string> | null;
  error?: string;
}

const failedCase = (name: string, error: string): EditCaseOutput => ({
  name,
  saves: [0, 0],
  repeatable: false,
  crossRunSame: false,
  verdictSame: false,
  objstmsVerdict: null,
  files: null,
  error,
});

function runEditCase<T>(
  name: string,
  outDir: string,
  fn: () => T,
  verdict: (r: T) => unknown,
  password?: string,
): EditCaseOutput {
  try {
    const r1 = withDualSave('base', fn, password);
    const r2 = withDualSave('objstms', fn, password);
    const last1 = r1.saves.at(-1);
    const last2 = r2.saves.at(-1);
    const files = last2
      ? {
          base: join(outDir, `${name}.base.pdf`),
          objstms: join(outDir, `${name}.objstms.pdf`),
        }
      : null;
    if (files && last2) {
      writeFileSync(files.base, last2.base);
      writeFileSync(files.objstms, last2.objstms);
    }
    return {
      name,
      saves: [r1.saves.length, r2.saves.length],
      repeatable: [...r1.saves, ...r2.saves].every((s) => s.repeatable),
      crossRunSame:
        !!last1 &&
        !!last2 &&
        sameOutput(last1.base, last2.base, password) &&
        sameOutput(last1.objstms, last2.objstms, password),
      verdictSame:
        JSON.stringify(stripVolatile(r1.value)) === JSON.stringify(stripVolatile(r2.value)),
      objstmsVerdict: verdict(r2.value),
      files,
    };
  } catch (e) {
    return failedCase(name, String(e));
  }
}

interface EditSpec {
  kind: 'corpus' | 'm0' | 'user-password';
  input?: string;
  name: string;
  password?: string;
  outDir: string;
  ttf: string;
}

/** 사용자 비밀번호 문서: 인증 후 1쪽 첫 텍스트 블록(20자 이상)을 redaction 으로 지우고 전체 저장. */
function userPasswordEdit(input: Uint8Array, password: string) {
  const doc = open(input, password);
  const page = doc.loadPage(0) as mupdf.PDFPage;
  const blocks = JSON.parse(page.toStructuredText('preserve-whitespace').asJSON()) as {
    blocks: {
      type: string;
      bbox: { x: number; y: number; w: number; h: number };
      lines: { text: string }[];
    }[];
  };
  const block = blocks.blocks.find(
    (b) => b.type === 'text' && squash(b.lines.map((l) => l.text).join('')).length >= 20,
  )!;
  const target = squash(block.lines.map((l) => l.text).join(''));
  const rect: Rect = [
    block.bbox.x,
    block.bbox.y,
    block.bbox.x + block.bbox.w,
    block.bbox.y + block.bbox.h,
  ];
  redactRegions(page, [rect]);
  page.destroy();
  const decision = decideSaveMethod(['redaction'], doc.canBeSavedIncrementally());
  const buf = doc.saveToBuffer(decision.options);
  const out = buf.asUint8Array().slice();
  buf.destroy();
  doc.destroy();
  const re = open(out, password);
  const p = re.loadPage(0);
  const after = squash(p.toStructuredText('preserve-whitespace').asText());
  p.destroy();
  re.destroy();
  return { method: decision.method, target, targetRemoved: !after.includes(target) };
}

function runEditTask(spec: EditSpec): EditCaseOutput[] {
  const fontBytes = readBytes(spec.ttf);
  if (spec.kind === 'corpus') {
    const bytes = readBytes(spec.input!);
    const { paragraphs } = analyzeForEdit(bytes);
    if (paragraphs.length === 0) return [failedCase(spec.name, '편집 문단 없음')];
    return [
      runEditCase(
        spec.name,
        spec.outDir,
        () => runCorpusEdit({ bytes, paragraphs, fontBytes }),
        (r) => ({
          saveOk: r.save.ok,
          paragraphs: r.paragraphs.length,
          failures: r.paragraphs.flatMap((p) => p.failures),
          textFound: r.paragraphs.every((p) => !p.reopen || p.reopen.textFound),
          targetLinesRemaining: r.paragraphs.reduce(
            (s, p) => s + (p.reopen?.targetLinesRemaining ?? 0),
            0,
          ),
          otherPagesDiffPx: r.otherPages.reduce((s, p) => s + p.diffPx, 0),
        }),
      ),
    ];
  }
  if (spec.kind === 'user-password') {
    const bytes = readBytes(spec.input!);
    return [
      runEditCase(
        spec.name,
        spec.outDir,
        () => userPasswordEdit(bytes, spec.password!),
        (r) => r,
        spec.password,
      ),
    ];
  }
  const sample = buildSamplePdf();
  const expected = buildSamplePdf({ includeTarget: false });
  const spike = (sampleBytes: Uint8Array) => () =>
    runSpike({ sampleBytes, expectedBytes: expected, fontBytes, fontName: 'NotoSansKR' });
  const spikeVerdict = (r: ReturnType<ReturnType<typeof spike>>) => ({
    method: r.save.method,
    reopen: { ...r.reopen, font: undefined },
  });
  const encrypted = (method: string) => {
    const d = openPdf(sample);
    const buf = d.saveToBuffer(
      `${BASE_OPTIONS},encrypt=${method},owner-password=${OWNER_PASSWORD}`,
    );
    const b = buf.asUint8Array().slice();
    buf.destroy();
    d.destroy();
    return b;
  };
  return [
    runEditCase('m0-day1-spike', spec.outDir, spike(sample), spikeVerdict),
    runEditCase(
      'm0-shared-xobject-sequential',
      spec.outDir,
      () => runXObjectCase('sequential', { fontBytes }),
      (r) => ({ reopen: r.reopen }),
    ),
    runEditCase(
      'm0-preexisting-redact-per-annotation',
      spec.outDir,
      () => runRedactCase('per-annotation', fontBytes),
      (r) => ({ reopen: r.reopen }),
    ),
    runEditCase(
      'm0-day1-spike-aes256-owner',
      spec.outDir,
      spike(encrypted('aes-256')),
      spikeVerdict,
    ),
    runEditCase(
      'm0-day1-spike-rc4-128-owner',
      spec.outDir,
      spike(encrypted('rc4-128')),
      spikeVerdict,
    ),
  ];
}

interface PdfjsSpec {
  base: string;
  objstms: string;
  password?: string;
}

/** 자식 프로세스 진입점(`--child objstms-<작업> --spec <json>`). 결과는 spec.result 에 쓴다. */
export async function runObjstmsChild(task: string, specFile: string): Promise<void> {
  const spec = JSON.parse(readFileSync(specFile, 'utf8')) as { result: string } & Record<
    string,
    unknown
  >;
  const result =
    task === 'objstms-save'
      ? runSaveTask(spec as unknown as SaveSpec)
      : task === 'objstms-compare'
        ? runCompareTask(spec as unknown as CompareSpec)
        : task === 'objstms-pdfjs'
          ? await pdfjsCompare(
              { base: spec.base as string, objstms: spec.objstms as string },
              (spec as unknown as PdfjsSpec).password,
            )
          : task === 'objstms-resolve'
            ? runResolveTask(spec as unknown as ResolveSpec)
            : task === 'objstms-incremental'
              ? await runIncrementalTask(spec as unknown as IncrementalSpec)
              : task === 'objstms-edit'
                ? runEditTask(spec as unknown as EditSpec)
                : null;
  if (result === null) throw new Error(`알 수 없는 작업: ${task}`);
  writeFileSync(spec.result, JSON.stringify(result, null, 2));
}

// ───────────────────────── 실행기 ─────────────────────────

interface InputDoc {
  id: string;
  group: 'corpus' | 'm0' | 'synthetic' | 'encrypted';
  path: string;
  password?: string;
  /** 코퍼스 문서: 편집 단계 대상 */
  edit?: boolean;
}

/** 세대 번호가 0 이 아닌 객체(콘텐츠 5 1 R, 폰트 6 2 R)를 가진 PDF-1.4 xref 표 문서. */
export function buildGenerationPdf(): Uint8Array {
  const content = 'BT /F1 24 Tf 20 40 Td (Generation test) Tj ET';
  const objs: [number, number, string][] = [
    [1, 0, '<</Type/Catalog/Pages 2 0 R>>'],
    [2, 0, '<</Type/Pages/Kids[3 0 R]/Count 1>>'],
    [
      3,
      0,
      '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 5 1 R/Resources<</Font<</F1 6 2 R>>>>>>',
    ],
    [5, 1, `<</Length ${content.length}>>\nstream\n${content}\nendstream`],
    [6, 2, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'],
  ];
  let s = '%PDF-1.4\n';
  const offsets = new Map<number, [number, number]>();
  for (const [num, gen, body] of objs) {
    offsets.set(num, [s.length, gen]);
    s += `${num} ${gen} obj\n${body}\nendobj\n`;
  }
  const xref = s.length;
  s += 'xref\n0 7\n0000000000 65535 f \n';
  for (let num = 1; num < 7; num++) {
    const o = offsets.get(num);
    s += o
      ? `${String(o[0]).padStart(10, '0')} ${String(o[1]).padStart(5, '0')} n \n`
      : '0000000000 00001 f \n';
  }
  s += `trailer\n<</Size 7/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(s);
}

/** 암호화 변형: 원본을 MuPDF 로 암호화해 저장(입력 형식 objstms 여부 선택). */
function encryptPdf(src: Uint8Array, method: string, user: boolean, objstms: boolean): Uint8Array {
  const doc = openPdf(src);
  const options = [
    objstms ? OBJSTMS_OPTIONS : BASE_OPTIONS,
    `encrypt=${method}`,
    `owner-password=${OWNER_PASSWORD}`,
    ...(user ? [`user-password=${USER_PASSWORD}`] : []),
  ].join(',');
  const buf = doc.saveToBuffer(options);
  const out = buf.asUint8Array().slice();
  buf.destroy();
  doc.destroy();
  return out;
}

function collectInputs(root: string, inputsDir: string): { docs: InputDoc[]; skipped: string[] } {
  const docs: InputDoc[] = [];
  const skipped: string[] = [];
  const manifest = JSON.parse(
    readFileSync(join(root, 'fixtures/corpus/manifest.json'), 'utf8'),
  ) as CorpusManifest;
  for (const d of manifest.documents) {
    const path = join(root, 'fixtures/corpus', `${d.id}.pdf`);
    if (!existsSync(path) || sha256(readBytes(path)) !== d.sha256) skipped.push(d.id);
    else docs.push({ id: d.id, group: 'corpus', path, edit: true });
  }
  const m0 = join(root, 'fixtures/m0');
  for (const f of readdirSync(m0)
    .filter((f) => f.endsWith('.pdf'))
    .sort())
    docs.push({ id: f.replace(/\.pdf$/, ''), group: 'm0', path: join(m0, f) });
  const gen = join(inputsDir, 'synthetic-generation.pdf');
  writeFileSync(gen, buildGenerationPdf());
  docs.push({ id: 'synthetic-generation', group: 'synthetic', path: gen });
  const variants: [string, string, string, boolean, boolean][] = [
    // [원본 id, 원본 경로, 방식, 사용자 비밀번호, 입력 objstms]
    ['m0-shared-xobject', join(m0, 'm0-shared-xobject.pdf'), 'aes-256', false, false],
    ['m0-shared-xobject', join(m0, 'm0-shared-xobject.pdf'), 'aes-256', true, false],
    ['m0-shared-xobject', join(m0, 'm0-shared-xobject.pdf'), 'aes-128', false, false],
    ['m0-shared-xobject', join(m0, 'm0-shared-xobject.pdf'), 'rc4-128', false, false],
    ['m0-shared-xobject', join(m0, 'm0-shared-xobject.pdf'), 'rc4-40', false, false],
    [
      'zen-ko-kimtw-23386644',
      join(root, 'fixtures/corpus/zen-ko-kimtw-23386644.pdf'),
      'aes-256',
      false,
      true,
    ],
    [
      'zen-ko-kimtw-23386644',
      join(root, 'fixtures/corpus/zen-ko-kimtw-23386644.pdf'),
      'aes-256',
      true,
      true,
    ],
    [
      'zen-ko-kimtw-23386644',
      join(root, 'fixtures/corpus/zen-ko-kimtw-23386644.pdf'),
      'rc4-128',
      false,
      true,
    ],
  ];
  for (const [srcId, src, method, user, objstms] of variants) {
    if (!existsSync(src)) continue;
    const id = `enc-${srcId}-${method}-${user ? 'user' : 'owner'}${objstms ? '-objstm' : ''}`;
    const path = join(inputsDir, `${id}.pdf`);
    writeFileSync(path, encryptPdf(readBytes(src), method, user, objstms));
    docs.push({
      id,
      group: 'encrypted',
      path,
      ...(user ? { password: USER_PASSWORD } : {}),
      // 소유자 비밀번호만 있는 코퍼스 변형은 제품처럼 비밀번호 없이 열리므로 코퍼스 편집도 돌린다
      edit: srcId.startsWith('zen-') && !user,
    });
  }
  return { docs, skipped };
}

function runChild(
  cli: string,
  task: string,
  spec: object,
  specFile: string,
): Promise<{ ok: boolean; stderr: string }> {
  writeFileSync(specFile, JSON.stringify(spec, null, 2));
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, '--child', task, '--spec', specFile], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    p.on('close', (code) =>
      resolve({ ok: code === 0, stderr: stderr.split('\n').slice(-8).join('\n') }),
    );
  });
}

async function pool<T>(items: T[], size: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

const readJson = <T>(p: string): T | null =>
  existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null;

export interface ObjstmsDocResult {
  id: string;
  group: InputDoc['group'];
  inputBytes: number;
  inputShape: FileShape;
  save: Partial<Record<Variant, SaveOutput>>;
  compare: CompareOutput | null;
  pdfjs: EngineCompare | null;
  resolve: ResolveOutput | null;
  incremental: IncrementalOutput | null;
  errors: string[];
}

export interface ObjstmsEditResult extends EditCaseOutput {
  compare: CompareOutput | null;
  pdfjs: EngineCompare | null;
}

export async function runObjstmsCli(opts: {
  root: string;
  out: string;
  ttf: string;
  tmp: string;
  /** 이 id(입력 문서 id, 'edit-m0')만 실행 */
  only: string[] | null;
}) {
  const { root, out, ttf, tmp } = opts;
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
  const dirs = Object.fromEntries(
    ['inputs', 'save', 'edit', 'compare', 'incremental', 'specs'].map((d) => {
      const p = join(out, d);
      mkdirSync(p, { recursive: true });
      return [d, p];
    }),
  ) as Record<'inputs' | 'save' | 'edit' | 'compare' | 'incremental' | 'specs', string>;
  mkdirSync(tmp, { recursive: true });
  const collected = collectInputs(root, dirs.inputs);
  const { skipped } = collected;
  const docs = opts.only ? collected.docs.filter((d) => opts.only!.includes(d.id)) : collected.docs;
  const parallel = Math.max(2, Math.floor(os.cpus().length / 4));
  const t0 = performance.now();
  const results = new Map<string, ObjstmsDocResult>();
  const spec = (name: string) => join(dirs.specs, `${name}.json`);

  // 1. 원본 저장: 시간 측정이므로 하나씩
  for (const d of docs) {
    const input = readBytes(d.path);
    const r: ObjstmsDocResult = {
      id: d.id,
      group: d.group,
      inputBytes: input.byteLength,
      inputShape: fileShape(input),
      save: {},
      compare: null,
      pdfjs: null,
      resolve: null,
      incremental: null,
      errors: [],
    };
    results.set(d.id, r);
    for (const v of VARIANTS) {
      const result = join(dirs.save, `${d.id}.${v}.json`);
      const c = await runChild(
        cli,
        'objstms-save',
        {
          input: d.path,
          variant: v,
          output: join(dirs.save, `${d.id}.${v}.pdf`),
          result,
          ...(d.password ? { password: d.password } : {}),
        },
        spec(`save-${d.id}-${v}`),
      );
      if (!c.ok) r.errors.push(`save ${v}: ${c.stderr}`);
      else r.save[v] = readJson<SaveOutput>(result)!;
    }
    console.log(
      `저장 ${d.id}: ${r.inputBytes} → ${r.save.base?.shape.bytes} / ${r.save.objstms?.shape.bytes} B`,
    );
  }

  // 2. 편집 후 저장(두 옵션 출력)
  const editSpecs: EditSpec[] = [
    ...docs
      .filter((d) => d.edit)
      .map((d) => ({
        kind: 'corpus' as const,
        input: d.path,
        name: `edit-${d.id}`,
        outDir: dirs.edit,
        ttf,
      })),
    ...(!opts.only || opts.only.includes('edit-m0')
      ? [{ kind: 'm0' as const, name: 'edit-m0', outDir: dirs.edit, ttf }]
      : []),
    ...docs
      .filter((d) => d.password)
      .map((d) => ({
        kind: 'user-password' as const,
        input: d.path,
        name: `edit-${d.id}`,
        password: d.password!,
        outDir: dirs.edit,
        ttf,
      })),
  ];
  const edits: ObjstmsEditResult[] = [];
  await pool(editSpecs, parallel, async (e) => {
    const result = join(dirs.edit, `${e.name}.json`);
    const c = await runChild(cli, 'objstms-edit', { ...e, result }, spec(e.name));
    const cases = c.ok ? readJson<EditCaseOutput[]>(result)! : [failedCase(e.name, c.stderr)];
    for (const x of cases) edits.push({ ...x, compare: null, pdfjs: null });
    console.log(`편집 ${e.name}: ${c.ok ? cases.map((x) => x.name).join(', ') : '실패'}`);
  });
  const passwordOf = (name: string) =>
    docs.find((d) => d.password && name === `edit-${d.id}`)?.password;

  // 3. 비교(MuPDF·Poppler / pdf.js), 4. resolve(), 5. 증분 저장
  type Job = {
    name: string;
    task: string;
    spec: object;
    done: (ok: boolean, stderr: string, result: string) => void;
  };
  const jobs: Job[] = [];
  for (const d of docs) {
    const r = results.get(d.id)!;
    if (!r.save.base || !r.save.objstms) continue;
    const files = {
      base: join(dirs.save, `${d.id}.base.pdf`),
      objstms: join(dirs.save, `${d.id}.objstms.pdf`),
    };
    const pw = d.password ? { password: d.password } : {};
    jobs.push(
      {
        name: `compare-${d.id}`,
        task: 'objstms-compare',
        spec: { orig: d.path, ...files, ...pw, tmp },
        done: (ok, err, res) =>
          ok ? (r.compare = readJson(res)) : r.errors.push(`compare: ${err}`),
      },
      {
        name: `pdfjs-${d.id}`,
        task: 'objstms-pdfjs',
        spec: { ...files, ...pw },
        done: (ok, err, res) => (ok ? (r.pdfjs = readJson(res)) : r.errors.push(`pdfjs: ${err}`)),
      },
      {
        name: `resolve-${d.id}`,
        task: 'objstms-resolve',
        spec: { input: d.path, plain: files.objstms, ...pw },
        done: (ok, err, res) =>
          ok ? (r.resolve = readJson(res)) : r.errors.push(`resolve: ${err}`),
      },
      {
        name: `incremental-${d.id}`,
        task: 'objstms-incremental',
        spec: { inputs: { orig: d.path, ...files }, ...pw, outDir: dirs.incremental, id: d.id },
        done: (ok, err, res) =>
          ok ? (r.incremental = readJson(res)) : r.errors.push(`incremental: ${err}`),
      },
    );
  }
  for (const e of edits) {
    if (!e.files) continue;
    const pw = passwordOf(e.name);
    const p = pw ? { password: pw } : {};
    jobs.push(
      {
        name: `compare-${e.name}`,
        task: 'objstms-compare',
        spec: { ...e.files, ...p, tmp },
        done: (ok, err, res) => (ok ? (e.compare = readJson(res)) : (e.error = `compare: ${err}`)),
      },
      {
        name: `pdfjs-${e.name}`,
        task: 'objstms-pdfjs',
        spec: { ...e.files, ...p },
        done: (ok, err, res) => (ok ? (e.pdfjs = readJson(res)) : (e.error = `pdfjs: ${err}`)),
      },
    );
  }
  let finished = 0;
  await pool(jobs, parallel, async (j) => {
    const result = join(dirs.compare, `${j.name}.json`);
    const c = await runChild(cli, j.task, { ...j.spec, result }, spec(j.name));
    j.done(c.ok, c.stderr, result);
    if (++finished % 20 === 0) console.log(`비교 ${finished}/${jobs.length}`);
  });

  const summary = {
    date: new Date().toISOString(),
    node: process.version,
    mupdf: (
      JSON.parse(
        readFileSync(join(dirname(require.resolve('mupdf')), '..', 'package.json'), 'utf8'),
      ) as { version: string }
    ).version,
    poppler: popplerVersion(),
    pdfjs: `${pdfjs.version} (${pdfjs.build})`,
    options: OPTIONS,
    fullSaveOptions: FULL_SAVE_OPTIONS,
    elapsedMs: performance.now() - t0,
    skipped,
    documents: [...results.values()],
    edits: edits.sort((a, b) => a.name.localeCompare(b.name)),
  };
  writeFileSync(join(out, 'objstms-result.json'), JSON.stringify(summary, null, 2));
  const md = summarize(summary);
  writeFileSync(join(out, 'summary.md'), md);
  console.log(md);
  console.log(`\n결과: ${relative(root, join(out, 'objstms-result.json'))}`);
}

// ───────────────────────── 요약 ─────────────────────────

const engineOk = (e: EngineCompare | null | undefined) =>
  !!e &&
  !e.error &&
  e.renderDiffPages === 0 &&
  e.textDiffPages === 0 &&
  e.pages.base === e.pages.objstms;

const graphOk = (g: GraphCompare | { error: string } | undefined) =>
  !!g &&
  !('error' in g) &&
  g.differing === 0 &&
  g.missingInObjstms === 0 &&
  Object.keys(g.onlyInObjstms).length === 0 &&
  g.trailer.root &&
  g.trailer.info &&
  g.trailer.encrypt &&
  g.encryptTopLevel !== false;

const mark = (ok: boolean) => (ok ? '동일' : '**차이**');
const engineCell = (e: EngineCompare | null | undefined) =>
  !e ? '-' : e.error ? `**오류**` : `${mark(engineOk(e))}(${e.pages.base}/${e.pages.objstms}쪽)`;

function summarize(s: {
  documents: ObjstmsDocResult[];
  edits: ObjstmsEditResult[];
  options: Record<Variant, string>;
}): string {
  const md: string[] = [];
  md.push('### 원본 저장', '');
  md.push(
    '| 문서 | 입력 B | 입력 xref | BASE B(배율) | OBJSTMS B(배율) | 헤더 BASE→OBJSTMS | 저장 ms BASE / OBJSTMS(중앙값) | 힙 MiB BASE / OBJSTMS | 객체 비교 | MuPDF | Poppler | pdf.js |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const d of s.documents) {
    const a = d.save.base;
    const b = d.save.objstms;
    const ratio = (x?: SaveOutput) =>
      x
        ? `${x.shape.bytes.toLocaleString('en-US')}(${(x.shape.bytes / d.inputBytes).toFixed(2)})`
        : '실패';
    const g = d.compare?.graph;
    md.push(
      `| ${d.id} | ${d.inputBytes.toLocaleString('en-US')} | ${d.inputShape.lastXref} | ${ratio(a)} | ${ratio(b)} | ${a?.shape.header ?? '-'}→${b?.shape.header ?? '-'} | ${a ? median(a.saveMs).toFixed(1) : '-'} / ${b ? median(b.saveMs).toFixed(1) : '-'} | ${a?.wasmHeapBytes ? (a.wasmHeapBytes / 2 ** 20).toFixed(1) : '-'} / ${b?.wasmHeapBytes ? (b.wasmHeapBytes / 2 ** 20).toFixed(1) : '-'} | ${g ? ('error' in g ? '**오류**' : `${mark(graphOk(g))}(${g.objects.base}/${g.objects.objstms})`) : '-'} | ${engineCell(d.compare?.mupdf)} | ${engineCell(d.compare?.poppler)} | ${engineCell(d.pdfjs)} |`,
    );
  }
  md.push('', '### 편집 후 저장', '');
  md.push(
    '| 편집 | 재저장 동일 | 실행 간 동일 | 판정 동일 | 객체 비교 | MuPDF | Poppler | pdf.js | BASE B / OBJSTMS B |',
    '|---|---|---|---|---|---|---|---|---|',
  );
  for (const e of s.edits) {
    const g = e.compare?.graph;
    md.push(
      `| ${e.name}${e.error ? ` (${e.error.split('\n')[0]})` : ''} | ${e.repeatable} | ${e.crossRunSame} | ${e.verdictSame} | ${g ? ('error' in g ? '**오류**' : mark(graphOk(g))) : '-'} | ${engineCell(e.compare?.mupdf)} | ${engineCell(e.compare?.poppler)} | ${engineCell(e.pdfjs)} | ${e.compare ? `${e.compare.shape.base.bytes.toLocaleString('en-US')} / ${e.compare.shape.objstms.bytes.toLocaleString('en-US')}` : '-'} |`,
    );
  }
  md.push('', '### resolve() 후 저장(F3)·증분 저장', '');
  md.push(
    '| 문서 | resolve 이미지/Form | OBJSTMS: 그냥 저장과 객체 동일 | OBJSTMS 소실 이미지 | 대조 compact 소실 이미지 | canBeSavedIncrementally 원본/BASE/OBJSTMS/세션BASE/세션OBJSTMS | 증분 방식(원본) | 증분 마지막 xref 원본/BASE/OBJSTMS/세션BASE/세션OBJSTMS | 증분 재열기 3엔진(5사례) | incremental,objstms |',
    '|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const d of s.documents) {
    const r = d.resolve;
    const inc = d.incremental;
    const cases = inc
      ? (['orig', 'base', 'objstms', 'session-base', 'session-objstms'] as const).map(
          (k) => inc.cases[k],
        )
      : [];
    const reopenOk = cases.every(
      (c) =>
        c &&
        !c.error &&
        c.reopen.mupdf?.notes === 1 &&
        c.reopen.poppler !== null &&
        c.reopen.poppler.errors <= (inc?.popplerBaselineErrors ?? 0) &&
        c.reopen.pdfjs?.notes === 1,
    );
    md.push(
      `| ${d.id} | ${r ? `${r.resolved.images}/${r.resolved.forms}` : '-'} | ${r ? mark(graphOk(r.vsPlain)) : '-'} | ${r?.lostImages ?? '-'} | ${r?.compactLostImages ?? '-'} | ${cases.map((c) => (c ? String(c.canBeSavedIncrementally) : '-')).join('/')} | ${cases[0]?.method ?? '-'} | ${cases.map((c) => c?.shape?.lastXref ?? '-').join('/')} | ${inc ? (reopenOk ? '정상' : '**확인**') : '-'} | ${inc ? (inc.incrementalObjstms.ok ? `성공(incremental 과 같은 내용 ${inc.incrementalObjstms.sameAsIncremental})` : `실패: ${inc.incrementalObjstms.error}`) : '-'} |`,
    );
  }
  return md.join('\n');
}
