/**
 * Draft-start application (docs/m3-contract.md D2, D3, 5.2): removes the original paragraph + calls an empty edit block at the insertion point.
 *
 * - Removal, insertion, name replacement and ActualText replacement in one stream are applied at once as a single replacement list based on that stream's original bytes.
 * - For text inside a Form, the usage path (including the parent chain) is duplicated byte by byte and only the Do name operand is changed to the new name.
 *   /StructParents is removed from the copy (so two streams do not hold the same ParentTree key).
 * - If the page /Contents stream is shared with another page or another slot of the same array, a copy is made and only this page's slot is changed.
 * - Edit block: /Matrix = inverse of the insertion-point CTM (inside the block = user space), /BBox = user-space areaLimit.
 */
import type * as mupdf from 'mupdf';
import type {
  ContentStreamRef,
  InsertionInfo,
  Matrix,
  ParagraphEditPlan,
  Rect,
  SourceOp,
} from '@pdf-editor/shared-types';
import { parseContentOpsLenient, type Token } from './content-stream.js';
import {
  invert,
  latin1String,
  lookupResource,
  padReplacement,
  resourceChain,
  StreamCache,
  transformRect,
} from './edit-common.js';
import { analyzeParagraph, makeEnv, type EditAnalysis } from './edit-plan.js';
import { extGStateOf, resolveStyle, type ResolvedStyle } from './edit-style.js';
import { ownResources, ownSubdict, putUniqueResource } from './page-content.js';
import type { FontCache } from './pdf-fonts.js';
import type { ParagraphEditContext, PreparedEdit } from './paragraph-edit.js';
import { rewriteShow } from './show-ops.js';
import {
  applyReplacements,
  contentsSlotNumber,
  contentsUseCount,
  replaceContentsSlot,
  type Replacement,
} from './text-remove.js';
import { writeStreamBytes } from './mupdf-util.js';

/** Draft-start resolution needed to write the edit block (per edit id). */
export interface WriteContext {
  editId: string;
  blockNum: number;
  pageIndex: number;
  /** sourceChar → resolved style (classification-time PageModel index). */
  styles: Map<number, ResolvedStyle>;
  /** ExtGState at the insertion point (outer → inner). */
  insertionGs: mupdf.PDFObject[];
  insertion: InsertionInfo;
  areaLimit: Rect;
  userToPage: Matrix;
}

const contexts = new WeakMap<mupdf.PDFDocument, Map<string, WriteContext>>();
const latest = new WeakMap<mupdf.PDFDocument, WriteContext>();

/**
 * Style resolution of a draft (R-L4). If absent from the kept resolution, the resolution of the nearest character number is used. The changed document is not re-read with the
 * classification-time SourceMap range.
 */
export function styleFor(wc: WriteContext, sourceChar: number): ResolvedStyle | null {
  const hit = wc.styles.get(sourceChar);
  if (hit) return hit;
  let best: ResolvedStyle | null = null;
  let dist = Infinity;
  for (const [sc, st] of wc.styles) {
    const d = Math.abs(sc - sourceChar);
    if (d < dist || (d === dist && best !== null && sc < best.sourceChar)) {
      best = st;
      dist = d;
    }
  }
  return best;
}

export function writeContextOf(doc: mupdf.PDFDocument, editId: string): WriteContext | undefined {
  return contexts.get(doc)?.get(editId);
}

/** The last draft of this document (one draft per document, contract 5.7). */
export function latestWriteContext(doc: mupdf.PDFDocument): WriteContext | undefined {
  return latest.get(doc);
}

/**
 * Discards the write resolution of a draft (R-L3). Without editId, all resolutions of this document. Called after commit, cancel and reapply. The PDFObjects
 * (font, ExtGState) the resolution holds are owned by the document, so they are not released, only the reference is dropped.
 */
export function releaseWriteContext(doc: mupdf.PDFDocument, editId?: string): void {
  if (editId === undefined) {
    contexts.delete(doc);
    latest.delete(doc);
    return;
  }
  contexts.get(doc)?.delete(editId);
  if (latest.get(doc)?.editId === editId) latest.delete(doc);
}

function register(doc: mupdf.PDFDocument, wc: WriteContext): void {
  let m = contexts.get(doc);
  if (!m) {
    m = new Map();
    contexts.set(doc, m);
  }
  m.set(wc.editId, wc);
  latest.set(doc, wc);
}

/**
 * Classification-time style resolution. Call before changing the document. In addition to the sourceChar of plan.runs and paragraph styleRuns, resolves all target characters
 * (reads once per operation and only changes fontId and size per character). This is because during a draft the document has changed and cannot be
 * re-read with the SourceMap range (R-L4).
 */
function resolveStyles(
  ctx: ParagraphEditContext,
  plan: Omit<ParagraphEditPlan, 'revision'>,
  a: EditAnalysis,
  streams: StreamCache,
): Map<number, ResolvedStyle> {
  const out = new Map<number, ResolvedStyle>();
  const scs = new Set<number>(plan.runs.map((r) => r.style.sourceChar));
  for (const r of a.paragraph.styleRuns) {
    const c = a.paragraph.chars[r.start];
    if (c !== undefined) scs.add(c);
  }
  for (const sc of scs) {
    const s = resolveStyle(ctx, sc, streams);
    if (s) out.set(sc, s);
  }
  const byOp = new Map<number, ResolvedStyle | null>();
  for (const c of a.chars) {
    if (out.has(c)) continue;
    const opId = ctx.linkage.charOp[c] ?? -1;
    if (opId < 0) continue;
    let base = byOp.get(opId);
    if (base === undefined) {
      base = resolveStyle(ctx, c, streams);
      byOp.set(opId, base);
      if (base) {
        out.set(c, base);
        continue;
      }
    }
    const ch = ctx.model.chars[c];
    if (base && ch) out.set(c, { ...base, sourceChar: c, fontId: ch.fontId, size: ch.size });
  }
  return out;
}

/** SourceOp of a Do operation (its stream and name operand range). */
function doOpOf(
  ctx: ParagraphEditContext,
  stream: ContentStreamRef,
  nameStart: number,
): SourceOp | null {
  return (
    ctx.map.ops.find(
      (o) =>
        o.op === 'Do' &&
        o.stream.objectNumber === stream.objectNumber &&
        o.stream.contentsIndex === stream.contentsIndex &&
        o.range[0] <= nameStart &&
        nameStart < o.range[1],
    ) ?? null
  );
}

/** Replacement info that removes ActualText from a BDC operation (inline dictionary) or replaces the name operand. */
function actualTextEdit(
  bytes: Uint8Array,
): { kind: 'inline'; text: string } | { kind: 'name'; name: string; nameTok: Token } | null {
  const p = parseContentOpsLenient(bytes).ops[0];
  if (!p || p.op !== 'BDC') return null;
  const toks = p.operands;
  const open = toks.findIndex((t) => t.kind === 'dict-open');
  if (open >= 0) {
    let depth = 0;
    for (let i = open; i < toks.length; i++) {
      const t = toks[i]!;
      if (t.kind === 'dict-open' || t.kind === 'array-open') depth++;
      else if (t.kind === 'dict-close' || t.kind === 'array-close') depth--;
      if (depth === 1 && t.kind === 'name' && t.value === 'ActualText') {
        const v = toks[i + 1];
        if (!v || (v.kind !== 'string' && v.kind !== 'hexstring')) return null;
        const text = latin1String(bytes.subarray(0, t.start)) + latin1String(bytes.subarray(v.end));
        return { kind: 'inline', text };
      }
    }
    return null;
  }
  const names = toks.filter((t) => t.kind === 'name');
  const nameTok = names[1];
  if (!nameTok) return null;
  return { kind: 'name', name: nameTok.value as string, nameTok };
}

/** Removes the original paragraph and inserts an empty edit block (body of prepareParagraphEdit). */
export function prepareEdit(
  ctx: ParagraphEditContext,
  plan: Omit<ParagraphEditPlan, 'revision'>,
  editId: string,
  fonts: FontCache,
): PreparedEdit {
  if (!plan.editable) {
    throw new Error(`편집할 수 없는 문단: ${plan.limits.map((l) => l.reason).join(', ')}`);
  }
  const doc = ctx.doc;
  const env = makeEnv(ctx, fonts);
  const a = analyzeParagraph(env, plan.paragraphId);
  const seqs = a.chars.map((c) => ctx.model.chars[c]!.glyphSeq);
  if (seqs.join(',') !== plan.target.glyphSeqs.join(',')) {
    throw new Error('판정 이후 쪽 상태가 바뀜(대상 글자가 다름)');
  }
  if (a.limits.length > 0)
    throw new Error(`편집 제한: ${a.limits.map((l) => l.reason).join(', ')}`);
  const streams = env.streams;
  const styles = resolveStyles(ctx, plan, a, streams);
  const changed = new Set<number>();

  if (a.block && a.blockStep) {
    const step = a.blockStep;
    const blockObj = doc.newIndirect(step.objectNumber);
    blockObj.put('PdfEditorEdit', doc.newString(editId));
    changed.add(step.objectNumber);
    const doOp = doOpOf(ctx, step.stream, step.nameRange[0]);
    const insertionGs = (doOp?.state?.extGStateOps ?? [])
      .map((id) => extGStateOf(ctx, id, streams))
      .filter((d): d is mupdf.PDFObject => d !== null);
    register(doc, {
      editId,
      blockNum: step.objectNumber,
      pageIndex: ctx.pageIndex,
      styles,
      insertionGs,
      insertion: plan.insertion ?? {
        container: a.formPath.length > 0 ? 'form-clone' : 'page',
        mode: 'rewrite-block',
        mcidKept: a.blockFormat?.insertion.mcidKept ?? null,
      },
      areaLimit: a.areaLimit,
      userToPage: ctx.map.userToPage,
    });
    return {
      editId,
      target: plan.target,
      block: { editId, objectNumber: step.objectNumber },
      changedObjects: [...changed].sort((x, y) => x - y),
    };
  }

  const ins = a.insertion;
  if (!ins) throw new Error('삽입점 없음');
  const insertionGs = (ins.stateOp.state?.extGStateOps ?? [])
    .map((id) => extGStateOf(ctx, id, streams))
    .filter((d): d is mupdf.PDFObject => d !== null);
  const invCtm = invert(ins.ctm);
  const invU = invert(ctx.map.userToPage);
  if (!invCtm || !invU) throw new Error('특이 행렬');

  // 1. Edit block.
  const bbox = transformRect(a.areaLimit, invU);
  const dict = doc.newDictionary();
  dict.put('Type', doc.newName('XObject'));
  dict.put('Subtype', doc.newName('Form'));
  const arr = (vals: readonly number[]) => {
    const x = doc.newArray();
    for (const v of vals) x.push(doc.newReal(v));
    return x;
  };
  dict.put('BBox', arr(bbox));
  dict.put('Matrix', arr(invCtm));
  dict.put('Resources', doc.newDictionary());
  dict.put('PdfEditorEdit', doc.newString(editId));
  const block = doc.addStream('', dict);
  const blockNum = block.asIndirect();
  changed.add(blockNum);

  // 2. Replacement list (per stream key).
  const lists = new Map<string, Replacement[]>();
  const keyOfStream = (s: ContentStreamRef) =>
    s.contentsIndex === null ? `f:${s.objectNumber}` : `p:${s.contentsIndex}:${s.objectNumber}`;
  const add = (s: ContentStreamRef, r: Replacement) => {
    const k = keyOfStream(s);
    const l = lists.get(k) ?? [];
    l.push(r);
    lists.set(k, l);
  };
  const padded = (s: ContentStreamRef, start: number, end: number, text: string) =>
    padReplacement(streams.get(s.objectNumber), start, end, text);

  const path = a.formPath;
  const holderOf = (s: ContentStreamRef): number =>
    s.contentsIndex !== null ? -1 : path.findIndex((st) => st.objectNumber === s.objectNumber);
  const ops = ctx.map.ops;

  // Per-holder processing (inner Form copy → page). Holder index -1 = page.
  let childRef: mupdf.PDFObject = block;
  const holderIndices = [...path.keys()].reverse().concat([-1]);
  for (const hi of holderIndices) {
    const isPage = hi === -1;
    let res: mupdf.PDFObject;
    let clone: mupdf.PDFObject | null = null;
    if (isPage) {
      const holder = doc.findPage(ctx.pageIndex);
      const inherited = holder.getInheritable('Resources');
      res = ownResources(doc, holder, inherited.isNull() ? null : inherited);
      if (holder.isIndirect()) changed.add(holder.asIndirect());
    } else {
      const orig = doc.newIndirect(path[hi]!.objectNumber);
      const cd = doc.newDictionary();
      orig.forEach((v, k) => {
        const key = String(k);
        if (['Length', 'Filter', 'DecodeParms', 'StructParents', 'StructParent'].includes(key))
          return;
        cd.put(key, v);
      });
      clone = doc.addStream('', cd);
      res = ownResources(doc, clone, null);
      changed.add(clone.asIndirect());
    }
    // Register the name of the child (edit block or inner copy).
    const innermost = hi === path.length - 1 || (isPage && path.length === 0);
    const childName = putUniqueResource(
      ownSubdict(doc, res, 'XObject'),
      childRef,
      innermost ? 'PEB' : 'PEF',
    );
    if (innermost) {
      const blockName = childName;
      // Removal and insertion (streams of this holder).
      for (const r of a.removals) {
        const split =
          ins.splitOp === r.op.id && ins.splitGlyph !== null
            ? { glyph: ins.splitGlyph, insert: `ET q /${blockName} Do Q ${ins.resume}` }
            : null;
        const text = rewriteShow(r.op, streams.opBytes(r.op), r.analysis, r.remove, split);
        add(r.op.stream, {
          start: r.op.range[0],
          end: r.op.range[1],
          text: padded(r.op.stream, r.op.range[0], r.op.range[1], text),
        });
      }
      if (ins.splitOp === null) {
        const text =
          ins.mode === 'before-bt'
            ? `q /${blockName} Do Q\n`
            : `ET q /${blockName} Do Q ${ins.resume}\n`;
        add(ins.stream, {
          start: ins.offset,
          end: ins.offset,
          text: padded(ins.stream, ins.offset, ins.offset, text),
        });
      }
    } else {
      // Replace the inner-level Do name (nameRange of this holder's stream).
      const step = path[hi + 1]!;
      add(step.stream, { start: step.nameRange[0], end: step.nameRange[1], text: `/${childName}` });
    }
    // ActualText (BDC of this holder's stream).
    for (const id of a.actualTextClears) {
      const op = ops[id]!;
      if (holderOf(op.stream) !== hi) continue;
      const bytes = streams.opBytes(op);
      const e = actualTextEdit(bytes);
      if (!e) continue;
      if (e.kind === 'inline') {
        add(op.stream, { start: op.range[0], end: op.range[1], text: e.text });
      } else {
        const chain = resourceChain(doc, ctx.pageIndex, op.formPath);
        const props = lookupResource(chain, 'Properties', e.name)?.resolve();
        if (!props?.isDictionary()) continue;
        const copy = doc.newDictionary();
        props.forEach((v, k) => {
          if (String(k) !== 'ActualText') copy.put(String(k), v);
        });
        const pname = putUniqueResource(ownSubdict(doc, res, 'Properties'), copy, 'PEP');
        add(op.stream, {
          start: op.range[0] + e.nameTok.start,
          end: op.range[0] + e.nameTok.end,
          text: `/${pname}`,
        });
      }
    }
    // Apply this holder's stream.
    if (!isPage) {
      const num = path[hi]!.objectNumber;
      const list = lists.get(`f:${num}`) ?? [];
      writeStreamBytes(clone!, applyReplacements(streams.get(num), list));
      childRef = clone!;
    }
  }

  // 3. Page /Contents slot.
  const pageObj = doc.findPage(ctx.pageIndex);
  const writes: { slot: number; num: number; bytes: Uint8Array }[] = [];
  for (const [k, list] of lists) {
    if (!k.startsWith('p:')) continue;
    const [, slotS, numS] = k.split(':');
    const slot = Number(slotS);
    const num = Number(numS);
    if (contentsSlotNumber(pageObj, slot) !== num) {
      throw new Error(`SourceMap 이 문서와 다름: /Contents[${slot}] ≠ ${num} 0 R`);
    }
    writes.push({ slot, num, bytes: applyReplacements(streams.get(num), list) });
  }
  for (const w of writes) {
    if (contentsUseCount(doc, w.num) > 1) {
      const copy = doc.addStream(w.bytes, {});
      replaceContentsSlot(doc, pageObj, w.slot, copy);
      changed.add(copy.asIndirect());
    } else {
      writeStreamBytes(doc.newIndirect(w.num), w.bytes);
      changed.add(w.num);
    }
  }
  if (pageObj.isIndirect()) changed.add(pageObj.asIndirect());

  register(doc, {
    editId,
    blockNum,
    pageIndex: ctx.pageIndex,
    styles,
    insertionGs,
    insertion: plan.insertion ?? {
      container: path.length > 0 ? 'form-clone' : 'page',
      mode: ins.mode,
      mcidKept: ins.mcidKept,
    },
    areaLimit: a.areaLimit,
    userToPage: ctx.map.userToPage,
  });
  return {
    editId,
    target: plan.target,
    block: { editId, objectNumber: blockNum },
    changedObjects: [...changed].sort((x, y) => x - y),
  };
}
