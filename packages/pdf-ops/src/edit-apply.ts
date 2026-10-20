/**
 * 초안 시작 적용(docs/m3-contract.md D2·D3·5.2): 원 문단 제거 + 삽입점에 빈 편집 블록 호출.
 *
 * - 한 스트림의 제거·삽입·이름 교체·ActualText 교체는 그 스트림 원본 바이트 기준 교체 목록 하나로 한 번에 적용한다.
 * - Form 안 텍스트는 사용 경로(상위 체인 포함)를 바이트 단위로 복제하고 Do 이름 피연산자만 새 이름으로 바꾼다.
 *   복제본에서 /StructParents 를 지운다(같은 ParentTree 키를 두 스트림이 갖지 않게).
 * - 쪽 /Contents 스트림을 다른 쪽·같은 배열 다른 칸과 공유하면 사본을 만들어 이 쪽 칸만 바꾼다.
 * - 편집 블록: /Matrix = 삽입점 CTM 역행렬(블록 안 = 사용자 공간), /BBox = 사용자 공간 areaLimit.
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

/** 편집 블록 쓰기에 필요한 초안 시작 시점 해석(편집 id 별). */
export interface WriteContext {
  editId: string;
  blockNum: number;
  pageIndex: number;
  /** sourceChar → 해석한 모양(판정 시점 PageModel 인덱스). */
  styles: Map<number, ResolvedStyle>;
  /** 삽입점의 ExtGState(바깥 → 안). */
  insertionGs: mupdf.PDFObject[];
  insertion: InsertionInfo;
  areaLimit: Rect;
  userToPage: Matrix;
}

const contexts = new WeakMap<mupdf.PDFDocument, Map<string, WriteContext>>();
const latest = new WeakMap<mupdf.PDFDocument, WriteContext>();

/**
 * 초안의 모양 해석(R-L4). 보관한 해석에 없으면 가장 가까운 글자 번호의 해석을 쓴다. 바뀐 문서를 판정 시점 SourceMap
 * 범위로 다시 읽지 않는다.
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

/** 이 문서의 마지막 초안(문서당 초안은 하나, 계약 5.7). */
export function latestWriteContext(doc: mupdf.PDFDocument): WriteContext | undefined {
  return latest.get(doc);
}

/**
 * 초안의 쓰기 해석을 버린다(R-L3). editId 가 없으면 이 문서의 해석 전부. 커밋·취소·재적용 뒤에 부른다. 해석이 가진
 * PDFObject(폰트·ExtGState)는 문서 소유라 해제하지 않고 참조만 끊는다.
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
 * 판정 시점 모양 해석. 문서를 바꾸기 전에 부른다. plan.runs·문단 styleRuns 의 sourceChar 에 더해 대상 글자 전부를
 * 해석해 둔다(연산마다 한 번 읽고 글자별 fontId·size 만 바꾼다). 초안 중에는 문서가 바뀌어 SourceMap 범위로 다시 읽을
 * 수 없기 때문이다(R-L4).
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

/** Do 연산(그 스트림·이름 피연산자 범위)의 SourceOp. */
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

/** BDC 연산에서 ActualText 를 뺀 교체(인라인 사전) 또는 이름 피연산자 교체 정보. */
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

/** 원 문단 제거와 빈 편집 블록 삽입(prepareParagraphEdit 본체). */
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

  // 1. 편집 블록.
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

  // 2. 교체 목록(스트림 키별).
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

  // 홀더별 처리(안쪽 Form 복제본 → 쪽). 홀더 인덱스 -1 = 쪽.
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
    // 자식(편집 블록 또는 안쪽 복제본) 이름 등록.
    const innermost = hi === path.length - 1 || (isPage && path.length === 0);
    const childName = putUniqueResource(
      ownSubdict(doc, res, 'XObject'),
      childRef,
      innermost ? 'PEB' : 'PEF',
    );
    if (innermost) {
      const blockName = childName;
      // 제거·삽입(이 홀더의 스트림).
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
      // 안쪽 단계 Do 이름 교체(이 홀더 스트림의 nameRange).
      const step = path[hi + 1]!;
      add(step.stream, { start: step.nameRange[0], end: step.nameRange[1], text: `/${childName}` });
    }
    // ActualText(이 홀더 스트림의 BDC).
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
    // 이 홀더 스트림 적용.
    if (!isPage) {
      const num = path[hi]!.objectNumber;
      const list = lists.get(`f:${num}`) ?? [];
      writeStreamBytes(clone!, applyReplacements(streams.get(num), list));
      childRef = clone!;
    }
  }

  // 3. 쪽 /Contents 칸.
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
