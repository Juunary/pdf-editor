/**
 * Resolves the style source (RunStyle.sourceChar) (contract D4, 5.5): the font resource of that character's operation, the fill color operation (original color space),
 * the ExtGState dictionaries, and the render mode. Used by edit block writing and font assignment.
 *
 * Resolved with the classification-time SourceMap when a draft starts (prepareParagraphEdit) and kept per edit id. Later writes use the kept resolution even after the document
 * has changed (rewriting the same block changes the resource names).
 */
import type * as mupdf from 'mupdf';
import type { SourceOp } from '@pdf-editor/shared-types';
import { parseContentOpsLenient } from './content-stream.js';
import { lookupResource, resourceChain, StreamCache } from './edit-common.js';
import type { ParagraphEditContext } from './paragraph-edit.js';

/** One fill color operation. space is the cs color space name and resource (obj is null for a device color space). */
export interface ColorOpSpec {
  op: 'cs' | 'sc' | 'scn' | 'g' | 'rg' | 'k';
  nums: number[];
  space: { name: string; obj: mupdf.PDFObject | null } | null;
  /** scn pattern name (pattern fill, edit restricted). */
  pattern: string | null;
}

export interface ResolvedStyle {
  sourceChar: number;
  /** Font resource value (kept as is if an indirect reference). */
  fontRef: mupdf.PDFObject;
  fontId: number;
  /** Font size (page-space pt = block-space pt). */
  size: number;
  renderMode: number;
  fill: ColorOpSpec[];
  /** Effective ExtGState dictionaries (outer → inner). */
  gs: mupdf.PDFObject[];
  /** The fill is a pattern (tiling or shading). */
  pattern: boolean;
}

const DEVICE_SPACES = new Set(['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'G', 'RGB', 'CMYK']);

/** Reads one color operation. */
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

/** Resolves the style of sourceChar from the classification-time document and SourceMap. Returns null if the operation or font is not found. */
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

/** gs operation id → ExtGState dictionary (resolved object). */
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

/** Effective keys → values of an ExtGState list (later wins). Type and Font are excluded. */
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

/** Whether two values are the same PDF value (indirect references by number, others by serialized comparison). */
export function samePdfValue(
  a: mupdf.PDFObject | undefined,
  b: mupdf.PDFObject | undefined,
): boolean {
  if (!a || !b) return a === b;
  if (a.isIndirect() && b.isIndirect()) return a.asIndirect() === b.asIndirect();
  return a.toString() === b.toString();
}
