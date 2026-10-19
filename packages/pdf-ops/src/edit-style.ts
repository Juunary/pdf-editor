/**
 * 모양 원천(RunStyle.sourceChar) 해석(계약 D4·5.5): 그 글자 연산의 폰트 리소스, 채움 색 연산(원래 색공간),
 * ExtGState 사전, 렌더 모드. 편집 블록 쓰기와 폰트 배정이 쓴다.
 *
 * 초안 시작(prepareParagraphEdit) 때 판정 시점 SourceMap 으로 해석해 편집 id 별로 보관한다. 이후 쓰기는 문서가
 * 바뀐 뒤라도(같은 블록을 다시 쓰면 리소스 이름이 바뀐다) 보관한 해석을 쓴다.
 */
import type * as mupdf from 'mupdf';
import type { SourceOp } from '@pdf-editor/shared-types';
import { parseContentOpsLenient } from './content-stream.js';
import { lookupResource, resourceChain, StreamCache } from './edit-common.js';
import type { ParagraphEditContext } from './paragraph-edit.js';

/** 채움 색 연산 1개. space 는 cs 의 색공간 이름과 리소스(장치 색공간이면 obj null). */
export interface ColorOpSpec {
  op: 'cs' | 'sc' | 'scn' | 'g' | 'rg' | 'k';
  nums: number[];
  space: { name: string; obj: mupdf.PDFObject | null } | null;
  /** scn 의 패턴 이름(패턴 채움, 편집 제한). */
  pattern: string | null;
}

export interface ResolvedStyle {
  sourceChar: number;
  /** 폰트 리소스 값(간접 참조면 그대로). */
  fontRef: mupdf.PDFObject;
  fontId: number;
  /** 글자 크기(페이지 공간 pt = 블록 공간 pt). */
  size: number;
  renderMode: number;
  fill: ColorOpSpec[];
  /** 효력 있는 ExtGState 사전(바깥 → 안). */
  gs: mupdf.PDFObject[];
  /** 채움이 패턴(타일링·셰이딩)이다. */
  pattern: boolean;
}

const DEVICE_SPACES = new Set(['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'G', 'RGB', 'CMYK']);

/** 색 연산 하나를 읽는다. */
export function readColorOp(
  doc: mupdf.PDFDocument,
  pageIndex: number,
  op: SourceOp,
  bytes: Uint8Array,
): ColorOpSpec | null {
  const parsed = parseContentOpsLenient(bytes);
  const p = parsed.ops[0];
  if (!p || p.op !== op.op) return null;
  const nums = p.operands.filter((t) => t.kind === 'number').map((t) => t.value as number);
  const names = p.operands.filter((t) => t.kind === 'name').map((t) => t.value as string);
  const kind = op.op as ColorOpSpec['op'];
  if (kind === 'cs') {
    const name = names[0] ?? 'DeviceGray';
    if (name === 'Pattern') return { op: kind, nums, space: { name, obj: null }, pattern: '' };
    if (DEVICE_SPACES.has(name))
      return { op: kind, nums, space: { name, obj: null }, pattern: null };
    const obj = lookupResource(resourceChain(doc, pageIndex, op.formPath), 'ColorSpace', name);
    const res = obj?.resolve();
    const family = res?.isArray() ? res.get(0) : res;
    const isPattern = family?.isName() === true && family.asName() === 'Pattern';
    return { op: kind, nums, space: { name, obj }, pattern: isPattern ? '' : null };
  }
  if (kind === 'scn' && names.length > 0)
    return { op: kind, nums, space: null, pattern: names[0]! };
  return { op: kind, nums, space: null, pattern: null };
}

/** sourceChar 의 모양을 판정 시점 문서·SourceMap 에서 해석한다. 연산·폰트를 찾지 못하면 null. */
export function resolveStyle(
  ctx: ParagraphEditContext,
  sourceChar: number,
  streams: StreamCache = new StreamCache(ctx.doc),
): ResolvedStyle | null {
  const ch = ctx.model.chars[sourceChar];
  const opId = ctx.linkage.charOp[sourceChar] ?? -1;
  const op = opId >= 0 ? ctx.map.ops[opId] : undefined;
  if (!ch || !op?.text) return null;
  const chain = resourceChain(ctx.doc, ctx.pageIndex, op.formPath);
  const fontRef = lookupResource(chain, 'Font', op.text.fontResource);
  if (!fontRef || !fontRef.resolve().isDictionary()) return null;
  const fill: ColorOpSpec[] = [];
  for (const id of op.state?.fillColorOps ?? []) {
    const cop = ctx.map.ops[id];
    if (!cop) continue;
    const spec = readColorOp(ctx.doc, ctx.pageIndex, cop, streams.opBytes(cop));
    if (spec) fill.push(spec);
  }
  const gs: mupdf.PDFObject[] = [];
  for (const id of op.state?.extGStateOps ?? []) {
    const d = extGStateOf(ctx, id, streams);
    if (d) gs.push(d);
  }
  return {
    sourceChar,
    fontRef,
    fontId: ch.fontId,
    size: ch.size,
    renderMode: op.text.renderMode,
    fill,
    gs,
    pattern: fill.some((f) => f.pattern !== null),
  };
}

/** gs 연산 id → ExtGState 사전(해석된 객체). */
export function extGStateOf(
  ctx: ParagraphEditContext,
  opId: number,
  streams: StreamCache,
): mupdf.PDFObject | null {
  const gop = ctx.map.ops[opId];
  if (!gop) return null;
  const parsed = parseContentOpsLenient(streams.opBytes(gop));
  const name = parsed.ops[0]?.operands.find((t) => t.kind === 'name')?.value as string | undefined;
  if (name === undefined) return null;
  const obj = lookupResource(
    resourceChain(ctx.doc, ctx.pageIndex, gop.formPath),
    'ExtGState',
    name,
  );
  return obj && obj.resolve().isDictionary() ? obj.resolve() : null;
}

/** ExtGState 목록의 효력 있는 키 → 값(뒤가 이긴다). Type·Font 는 뺀다. */
export function effectiveGs(list: readonly mupdf.PDFObject[]): Map<string, mupdf.PDFObject> {
  const out = new Map<string, mupdf.PDFObject>();
  for (const d of list) {
    d.forEach((v, k) => {
      const key = String(k);
      if (key !== 'Type' && key !== 'Font') out.set(key, v);
    });
  }
  return out;
}

/** 두 값이 같은 PDF 값인가(간접 참조는 번호, 그 밖은 직렬화 비교). */
export function samePdfValue(
  a: mupdf.PDFObject | undefined,
  b: mupdf.PDFObject | undefined,
): boolean {
  if (!a || !b) return a === b;
  if (a.isIndirect() && b.isIndirect()) return a.asIndirect() === b.asIndirect();
  return a.toString() === b.toString();
}
