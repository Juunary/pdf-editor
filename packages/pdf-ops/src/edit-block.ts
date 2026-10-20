/**
 * 편집 블록 쓰기와 목록(docs/m3-contract.md 5.5·5.7·D3).
 *
 * 블록 스트림: `q` → 텍스트 상태 명시 → `BT` → 모양이 바뀔 때 채움 색(원래 색공간)·Tr·gs·Tf → 줄마다 `Tm` 절대
 * 위치 → 글자는 `TJ`(위치 차이를 1/1000 텍스트 공간 단위 숫자로) → `ET` → `Q`. 블록 공간 = 사용자 공간이다
 * (/Matrix 가 삽입점 CTM 을 상쇄). 문자열은 원본 폰트면 그 폰트의 코드 바이트, 폴백 폰트면 2바이트 gid.
 */
import type * as mupdf from 'mupdf';
import type { ParagraphFormat, Point, TextRun } from '@pdf-editor/shared-types';
import type { ReflowResult } from '@pdf-editor/reflow';
import { now } from './clock.js';
import { parseContentOpsLenient } from './content-stream.js';
import { apply, applyLinear, fmt9, invert, latin1Bytes, lookupResource } from './edit-common.js';
import { styleFor, writeContextOf, type WriteContext } from './edit-apply.js';
import type { BlockFormat } from './edit-plan.js';
import { cleanParagraphFormat, readBlockFormat } from './edit-plan.js';
import { effectiveGs, samePdfValue, type ColorOpSpec, type ResolvedStyle } from './edit-style.js';
import { FALLBACK_KEY, FALLBACK_NAME, type FontState } from './font-assign.js';
import { readStreamBytes } from './mupdf-util.js';
import type {
  EditBlockRef,
  ParagraphEditContext,
  PreparedEdit,
  WriteResult,
} from './paragraph-edit.js';
import { formatNumber } from './text-ops.js';

const hex = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
const f = formatNumber;

/** ExtGState 키 기본값(명세 기본 상태). SMask 는 판정(graphics-state-mismatch)에서 다룬다. */
function gsDefault(doc: mupdf.PDFDocument, key: string): mupdf.PDFObject | null {
  switch (key) {
    case 'ca':
    case 'CA':
    case 'FL':
    case 'LW':
      return doc.newReal(1);
    case 'BM':
      return doc.newName('Normal');
    case 'op':
    case 'OP':
    case 'AIS':
    case 'SA':
      return doc.newBoolean(false);
    case 'TK':
      return doc.newBoolean(true);
    case 'OPM':
    case 'LC':
    case 'LJ':
      return doc.newInteger(0);
    case 'ML':
      return doc.newReal(10);
    case 'RI':
      return doc.newName('RelativeColorimetric');
    default:
      return null;
  }
}

const STROKE_OF: Record<ColorOpSpec['op'], string> = {
  cs: 'CS',
  sc: 'SC',
  scn: 'SCN',
  g: 'G',
  rg: 'RG',
  k: 'K',
};

/** 블록 리소스 사전 모음. */
class BlockResources {
  readonly font = new Map<string, { name: string; ref: mupdf.PDFObject }>();
  readonly cs = new Map<string, { name: string; ref: mupdf.PDFObject }>();
  readonly gs: { name: string; dict: mupdf.PDFObject }[] = [];

  fontName(key: string, ref: mupdf.PDFObject): string {
    let e = this.font.get(key);
    if (!e) {
      e = { name: `F${this.font.size}`, ref };
      this.font.set(key, e);
    }
    return e.name;
  }

  csName(spec: ColorOpSpec): string {
    const space = spec.space!;
    if (!space.obj) return space.name;
    const o = space.obj;
    const key = o.isIndirect() ? `n${o.asIndirect()}` : `s${o.toString()}`;
    let e = this.cs.get(key);
    if (!e) {
      e = { name: `CS${this.cs.size}`, ref: o };
      this.cs.set(key, e);
    }
    return e.name;
  }

  build(doc: mupdf.PDFDocument): { dict: mupdf.PDFObject; names: string[] } {
    const res = doc.newDictionary();
    const names: string[] = [];
    if (this.font.size > 0) {
      const d = doc.newDictionary();
      for (const e of this.font.values()) {
        d.put(e.name, e.ref);
        names.push(e.name);
      }
      res.put('Font', d);
    }
    if (this.cs.size > 0) {
      const d = doc.newDictionary();
      for (const e of this.cs.values()) {
        d.put(e.name, e.ref);
        names.push(e.name);
      }
      res.put('ColorSpace', d);
    }
    if (this.gs.length > 0) {
      const d = doc.newDictionary();
      for (const e of this.gs) {
        d.put(e.name, e.dict);
        names.push(e.name);
      }
      res.put('ExtGState', d);
    }
    return { dict: res, names };
  }
}

function colorOps(spec: readonly ColorOpSpec[], res: BlockResources, stroke: boolean): string[] {
  if (spec.length === 0) return [stroke ? '0 G' : '0 g'];
  const out: string[] = [];
  if (spec[0]!.op === 'sc' || spec[0]!.op === 'scn')
    out.push(stroke ? '/DeviceGray CS' : '/DeviceGray cs');
  for (const s of spec) {
    const op = stroke ? STROKE_OF[s.op] : s.op;
    if (s.op === 'cs') out.push(`/${res.csName(s)} ${op}`);
    else out.push(`${s.nums.map(f).join(' ')} ${op}`);
  }
  return out;
}

/** 같은 gs 목록(초안의 삽입점·모양 원천)은 초안 동안 바뀌지 않으므로 효력값을 한 번만 계산한다. */
const gsCache = new WeakMap<readonly mupdf.PDFObject[], Map<string, mupdf.PDFObject>>();
function cachedGs(list: readonly mupdf.PDFObject[]): Map<string, mupdf.PDFObject> {
  let v = gsCache.get(list);
  if (!v) {
    v = effectiveGs(list);
    gsCache.set(list, v);
  }
  return v;
}

/** 삽입점과 원 글자의 ExtGState 가 다르면 원 글자 상태를 재현하는 gs 사전(계약 D3). 같으면 null. */
function gsFor(
  doc: mupdf.PDFDocument,
  wc: WriteContext,
  rs: ResolvedStyle,
  strokeLikeFill: boolean,
): mupdf.PDFObject | null {
  const ins = cachedGs(wc.insertionGs);
  const src = cachedGs(rs.gs);
  const keys = new Set([...ins.keys(), ...src.keys()]);
  keys.delete('SMask');
  const differs = [...keys].some((k) => !samePdfValue(ins.get(k), src.get(k)));
  const ca = src.get('ca');
  const caVal = ca?.isNumber() ? ca.asNumber() : 1;
  const CA = src.get('CA');
  const CAVal = CA?.isNumber() ? CA.asNumber() : 1;
  const fixStroke = strokeLikeFill && caVal !== CAVal;
  if (!differs && !fixStroke) return null;
  const d = doc.newDictionary();
  d.put('Type', doc.newName('ExtGState'));
  for (const k of keys) {
    const v = src.get(k) ?? gsDefault(doc, k);
    if (v) d.put(k, v);
  }
  if (strokeLikeFill) d.put('CA', doc.newReal(caVal));
  return d;
}

const asciiJson = (v: unknown) =>
  JSON.stringify(v).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

function fontLabel(ref: mupdf.PDFObject): string {
  const b = ref.resolve().get('BaseFont');
  return b.isName() ? b.asName() : '';
}

/** writeEditBlock 본체. */
export function writeBlock(
  ctx: ParagraphEditContext,
  prepared: PreparedEdit,
  runs: readonly TextRun[],
  format: ParagraphFormat,
  result: ReflowResult,
  state: FontState,
): WriteResult {
  const t0 = now();
  const doc = ctx.doc;
  const wc = writeContextOf(doc, prepared.editId);
  if (!wc) throw new Error(`prepareParagraphEdit 결과 없음: ${prepared.editId}`);
  const block = doc.newIndirect(prepared.block.objectNumber);
  const prevFormat = readBlockFormat(doc, prepared.block.objectNumber);
  const invU = invert(wc.userToPage);
  if (!invU) throw new Error('userToPage 특이 행렬');
  const norm = (v: Point): Point => {
    const l = Math.hypot(v[0], v[1]) || 1;
    return [v[0] / l, v[1] / l];
  };
  const ex = norm(applyLinear(invU, 1, 0));
  const up = applyLinear(invU, 0, -1);
  const upItalic = applyLinear(invU, 0.2, -1);
  const upN = norm(up);
  const res = new BlockResources();
  // 초안 중에는 문서가 바뀌었으므로 판정 시점 해석만 쓴다(R-L4).
  const styleOf = (sc: number): ResolvedStyle | null => styleFor(wc, sc);

  const out: string[] = ['q', '0 Tc 0 Tw 100 Tz 0 TL 0 Ts', 'BT'];
  let tj: string[] | null = null;
  const closeTJ = () => {
    if (tj && tj.length > 0) out.push(`[${tj.join(' ')}] TJ`);
    tj = null;
  };
  let curFont = '';
  let curSize = NaN;
  let curStyle = '';
  let curItalic: boolean | null = null;
  let strokeSetup = false;
  let pen: Point | null = null;
  const glyphOffsets: number[] = [];
  const syntheticRuns = runs.map(() => ({ bold: false, italic: false }));

  for (const line of result.lines) {
    let lineStart = true;
    for (const g of line) {
      const run = runs[g.runIndex];
      if (!run) throw new Error(`runIndex 범위 밖: ${g.runIndex}`);
      const rs = styleOf(run.style.sourceChar);
      if (!rs) throw new Error(`모양 원천을 찾지 못함: sourceChar ${run.style.sourceChar}`);
      let fontRef: mupdf.PDFObject;
      if (g.faceKey === FALLBACK_KEY) {
        const fb = state.fallbackRef();
        if (!fb) {
          throw new Error(
            '폴백 폰트 객체 없음(FallbackFontSource.ref() 가 null, core 가 저널을 켜기 전에 넣는다)',
          );
        }
        fontRef = fb;
        state.usedFallbackGids.add(g.gid);
      } else {
        fontRef = state.originalByKey(g.faceKey)?.ref ?? rs.fontRef;
      }
      const fontName = res.fontName(g.faceKey, fontRef);
      const styleKey = `${run.style.sourceChar}|${g.syntheticBold ? 1 : 0}`;
      const P = apply(invU, g.x, g.y);
      let needTm = lineStart || g.syntheticItalic !== curItalic;
      if (!needTm && pen) {
        const dx = P[0] - pen[0];
        const dy = P[1] - pen[1];
        if (Math.abs(dx * upN[0] + dy * upN[1]) > 1e-3) needTm = true;
      }
      if (fontName !== curFont || g.size !== curSize || styleKey !== curStyle || needTm) closeTJ();
      if (styleKey !== curStyle) {
        out.push(...colorOps(rs.fill, res, false));
        const tr = g.syntheticBold
          ? 2
          : rs.renderMode === 1 || rs.renderMode === 2
            ? rs.renderMode
            : 0;
        if (tr === 1 || tr === 2) {
          if (!strokeSetup) {
            out.push('[] 0 d 0 J 0 j');
            strokeSetup = true;
          }
          out.push(...colorOps(rs.fill, res, true), `${f(g.size * 0.03)} w`);
        }
        out.push(`${tr} Tr`);
        const gd = gsFor(doc, wc, rs, tr === 2 || tr === 1);
        if (gd) {
          const name = `GS${res.gs.length}`;
          res.gs.push({ name, dict: gd });
          out.push(`/${name} gs`);
        }
        curStyle = styleKey;
      }
      if (fontName !== curFont || g.size !== curSize) {
        out.push(`/${fontName} ${f(g.size)} Tf`);
        curFont = fontName;
        curSize = g.size;
      }
      tj ??= [];
      if (needTm) {
        const yAxis = g.syntheticItalic ? upItalic : up;
        out.push(`${[ex[0], ex[1], yAxis[0], yAxis[1], P[0], P[1]].map(fmt9).join(' ')} Tm`);
        curItalic = g.syntheticItalic;
      } else if (pen) {
        const along = (P[0] - pen[0]) * ex[0] + (P[1] - pen[1]) * ex[1];
        const adj = (-along * 1000) / g.size;
        if (Math.abs(adj) >= 0.0005) tj.push(f(adj));
      }
      const bytes =
        g.faceKey === FALLBACK_KEY ? Uint8Array.of((g.gid >> 8) & 0xff, g.gid & 0xff) : g.code;
      tj.push(`<${hex(bytes)}>`);
      const adv = (g.pdfWidth / 1000) * g.size;
      pen = [P[0] + ex[0] * adv, P[1] + ex[1] * adv];
      glyphOffsets.push(g.offset);
      if (g.syntheticBold) syntheticRuns[g.runIndex]!.bold = true;
      if (g.syntheticItalic) syntheticRuns[g.runIndex]!.italic = true;
      lineStart = false;
    }
  }
  closeTJ();
  out.push('ET', 'Q');
  const content = latin1Bytes(`${out.join('\n')}\n`);
  block.writeStream(content);
  const built = res.build(doc);
  block.put('Resources', built.dict);

  const missing = result.summary.glyphs
    .filter((g) => g.font.kind === 'missing')
    .map((g) => g.offset);
  const fmt: BlockFormat = {
    v: 1,
    // 현재 필드만 쓴다(이전 빌드의 overflow·fontScale 이 섞인 EditOp 를 재적용해도 남기지 않는다).
    format: cleanParagraphFormat(format) ?? format,
    runs: runs.map((r, i) => {
      const rs = styleOf(r.style.sourceChar);
      return {
        text: r.text,
        size: r.style.size,
        bold: r.style.bold,
        italic: r.style.italic,
        color: r.style.color,
        font: rs ? fontLabel(rs.fontRef) : FALLBACK_NAME,
        synthetic: syntheticRuns[i]!,
      };
    }),
    glyphOffsets,
    missing,
    insertion:
      wc.insertion.mode === 'rewrite-block' && prevFormat ? prevFormat.insertion : wc.insertion,
    areaLimit: wc.areaLimit,
  };
  block.put('PdfEditorFormat', doc.newString(asciiJson(fmt)));
  return { streamBytes: content.byteLength, resources: built.names, writeMs: now() - t0 };
}

/**
 * 리소스(쪽·Form 의 /XObject 사전, Form 재귀)에 /PdfEditorEdit Form 이 하나라도 있는가. 콘텐츠를 읽지 않는 빠른
 * 사전 검사다. listBlocks 가 찾는 블록은 모두 이 사전들 중 하나에 있으므로, false 이면 블록이 없다.
 */
function hasBlockResource(res: mupdf.PDFObject): boolean {
  const seen = new Set<number>();
  const visit = (r: mupdf.PDFObject, depth: number): boolean => {
    const xobjects = r.get('XObject');
    if (!xobjects.isDictionary()) return false;
    let found = false;
    xobjects.forEach((x) => {
      if (found || !x.isIndirect()) return;
      const num = x.asIndirect();
      if (seen.has(num)) return;
      seen.add(num);
      const st = x.get('Subtype');
      if (!st.isName() || st.asName() !== 'Form') return;
      if (!x.get('PdfEditorEdit').isNull()) {
        found = true;
        return;
      }
      const own = x.get('Resources');
      if (depth < 8 && !own.isNull() && visit(own, depth + 1)) found = true;
    });
    return found;
  };
  return visit(res, 0);
}

/** 쪽 콘텐츠(Form 재귀)에서 /PdfEditorEdit 가 있고 사용 위치가 1곳인 Form(계약 D3·5.7). */
export function listBlocks(doc: mupdf.PDFDocument, pageIndex: number): EditBlockRef[] {
  const pageObj = doc.findPage(pageIndex);
  const res = pageObj.getInheritable('Resources');
  // 블록 Form 이 리소스에 없으면 콘텐츠를 파싱하지 않는다(레이아웃 힌트로 쪽마다 부른다, docs/m3-integration.md 9.6).
  if (res.isNull() || !hasBlockResource(res)) return [];
  const contents = pageObj.get('Contents');
  const items: mupdf.PDFObject[] = [];
  if (contents.isArray()) for (let i = 0; i < contents.length; i++) items.push(contents.get(i));
  else if (!contents.isNull()) items.push(contents);
  const parts = items.filter((s) => s.isStream()).map((s) => readStreamBytes(s));
  const total = parts.reduce((n, p) => n + p.byteLength + 1, 0);
  const joined = new Uint8Array(Math.max(0, total - 1));
  let o = 0;
  parts.forEach((p, i) => {
    if (i > 0) joined[o++] = 0x20;
    joined.set(p, o);
    o += p.byteLength;
  });
  const uses = new Map<number, number>();
  const order: number[] = [];
  const active = new Set<number>();
  const walk = (bytes: Uint8Array, chain: mupdf.PDFObject[], depth: number) => {
    for (const op of parseContentOpsLenient(bytes).ops) {
      if (op.op !== 'Do') continue;
      const name = op.operands.find((t) => t.kind === 'name')?.value as string | undefined;
      if (name === undefined) continue;
      const x = lookupResource(chain, 'XObject', name);
      if (!x || !x.isIndirect()) continue;
      const st = x.get('Subtype');
      if (!st.isName() || st.asName() !== 'Form') continue;
      const num = x.asIndirect();
      if (!x.get('PdfEditorEdit').isNull()) {
        if (!uses.has(num)) order.push(num);
        uses.set(num, (uses.get(num) ?? 0) + 1);
        continue;
      }
      if (depth >= 8 || active.has(num)) continue;
      active.add(num);
      const own = x.get('Resources');
      walk(readStreamBytes(x), own.isNull() ? chain : [own, ...chain], depth + 1);
      active.delete(num);
    }
  };
  walk(joined, [res], 0);
  return order
    .filter((n) => uses.get(n) === 1)
    .map((n) => {
      const v = doc.newIndirect(n).get('PdfEditorEdit');
      return { editId: v.isString() ? v.asString() : String(n), objectNumber: n };
    });
}
