import * as mupdf from 'mupdf';
import type { Rect } from '@pdf-editor/shared-types';
import { concatBytes, parseContentOps, spliceBytes } from './content-stream.js';
import { readStreamBytes, writeStreamBytes } from './mupdf-util.js';
import { ownResources, ownSubdict, putUniqueResource } from './page-content.js';
import { TEXT_REPLACE_REDACTION, type RedactionOptions } from './redact.js';
import { formatNumber } from './text-ops.js';

/** PDF matrix [a b c d e f]. Point transform uses row vectors: p' = p × M (same convention as MuPDF `Matrix.concat`). */
export type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export interface UsageStep {
  /** XObject resource name in the container (page or parent Form) */
  resourceName: string;
  /** Ordinal (from 0) among the Do operators of the container content */
  doOrdinal: number;
  /** Byte range of the Do name operand. For a page, relative to the bytes of the Contents array joined with LF */
  nameRange: [number, number];
  /** CTM at this Do (container space → page user space) */
  ctm: Matrix;
}

export interface XObjectUsage {
  pageIndex: number;
  /** Do chain from the page to this usage location. Length 1 = the page draws it directly */
  path: UsageStep[];
  /** Indirect object number. 0 for a direct object */
  objectNumber: number;
  subtype: string;
  /** Form: Form space → page user space (/Matrix × CTM). Image: unit square → page user space */
  toPage: Matrix;
  /** Circumscribed rectangle in page user space of the Form BBox (unit square for an Image) (PDF coordinates, y up) */
  pageBox: Rect;
}

export interface UsageWalkOptions {
  /** Upper bound on Form recursion depth (page = 0). Default 8 */
  maxDepth?: number;
}

function toMatrix(obj: mupdf.PDFObject): Matrix {
  if (!obj.isArray() || obj.length !== 6) return [...IDENTITY];
  return [0, 1, 2, 3, 4, 5].map((i) => obj.get(i).asNumber()) as Matrix;
}

/**
 * PDF rectangle array → normalized Rect (x0 ≤ x1, y0 ≤ y1). Real documents' /BBox and /MediaBox are sometimes
 * flipped, like `[0 792 612 0]` (docs/m0-corpus-recheck.md C3, 4 of 9 Forms tested). MuPDF Rect.transform treats a flipped
 * rectangle as an empty rectangle, so normalize before transforming or comparing (PDF 32000-1 7.9.5).
 */
export function toRect(obj: mupdf.PDFObject): Rect {
  const [a, b, c, d] = [0, 1, 2, 3].map((i) => obj.get(i).asNumber()) as Rect;
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

function transformRect(r: Rect, m: Matrix): Rect {
  const t = mupdf.Rect.transform(r, m);
  return [t[0], t[1], t[2], t[3]];
}

const concat = (one: Matrix, two: Matrix) => mupdf.Matrix.concat(one, two) as Matrix;

interface PageContent {
  bytes: Uint8Array;
  /** Joined byte range per Contents array element (or single stream) */
  segments: { start: number; end: number }[];
}

function readPageContent(pageObj: mupdf.PDFObject): PageContent {
  const contents = pageObj.get('Contents');
  const streams: mupdf.PDFObject[] = [];
  if (contents.isArray()) contents.resolve().forEach((s) => void streams.push(s));
  else if (!contents.isNull()) streams.push(contents);
  const parts = streams.map((s) => readStreamBytes(s));
  const segments: PageContent['segments'] = [];
  let o = 0;
  for (const p of parts) {
    segments.push({ start: o, end: o + p.byteLength });
    o += p.byteLength + 1;
  }
  return { bytes: concatBytes(parts, 0x0a), segments };
}

function walk(
  content: Uint8Array,
  resources: mupdf.PDFObject,
  ctm0: Matrix,
  prefix: UsageStep[],
  pageIndex: number,
  maxDepth: number,
  active: Set<number>,
  out: XObjectUsage[],
): void {
  const stack: Matrix[] = [];
  let ctm = ctm0;
  let doOrdinal = 0;
  for (const op of parseContentOps(content)) {
    if (op.op === 'q') stack.push(ctm);
    else if (op.op === 'Q') ctm = stack.pop() ?? ctm;
    else if (op.op === 'cm' && op.operands.length === 6) {
      ctm = concat(op.operands.map((t) => Number(t.value)) as Matrix, ctm);
    } else if (op.op === 'Do') {
      const nameTok = op.operands.at(-1);
      if (!nameTok || nameTok.kind !== 'name') continue;
      const resourceName = nameTok.value as string;
      const step: UsageStep = {
        resourceName,
        doOrdinal: doOrdinal++,
        nameRange: [nameTok.start, nameTok.end],
        ctm,
      };
      const xobj = resources.get('XObject').get(resourceName);
      if (xobj.isNull()) continue;
      const objectNumber = xobj.isIndirect() ? xobj.asIndirect() : 0;
      const subtype = xobj.get('Subtype').isName() ? xobj.get('Subtype').asName() : '';
      const path = [...prefix, step];
      if (subtype === 'Form') {
        const toPage = concat(toMatrix(xobj.get('Matrix')), ctm);
        out.push({
          pageIndex,
          path,
          objectNumber,
          subtype,
          toPage,
          pageBox: transformRect(toRect(xobj.get('BBox')), toPage),
        });
        if (path.length < maxDepth && !(objectNumber && active.has(objectNumber))) {
          if (objectNumber) active.add(objectNumber);
          const formRes = xobj.get('Resources');
          walk(
            readStreamBytes(xobj),
            formRes.isNull() ? resources : formRes,
            toPage,
            path,
            pageIndex,
            maxDepth,
            active,
            out,
          );
          if (objectNumber) active.delete(objectNumber);
        }
      } else {
        out.push({
          pageIndex,
          path,
          objectNumber,
          subtype,
          toPage: ctm,
          pageBox: transformRect([0, 0, 1, 1], ctm),
        });
      }
    }
  }
}

/** XObject usage locations of the page content (including nested Forms). Order = content execution order (depth first). */
export function listXObjectUsages(
  doc: mupdf.PDFDocument,
  pageIndex: number,
  options: UsageWalkOptions = {},
): XObjectUsage[] {
  const pageObj = doc.findPage(pageIndex);
  const out: XObjectUsage[] = [];
  walk(
    readPageContent(pageObj).bytes,
    pageObj.getInheritable('Resources'),
    [...IDENTITY],
    [],
    pageIndex,
    options.maxDepth ?? 8,
    new Set(),
    out,
  );
  return out;
}

/** Collects XObject usage locations of the whole document by object number (direct objects excluded). Two or more means a shared object. */
export function indexXObjectUsages(
  doc: mupdf.PDFDocument,
  options: UsageWalkOptions = {},
): Map<number, XObjectUsage[]> {
  const index = new Map<number, XObjectUsage[]>();
  for (let p = 0; p < doc.countPages(); p++) {
    for (const u of listXObjectUsages(doc, p, options)) {
      if (!u.objectNumber) continue;
      const list = index.get(u.objectNumber) ?? [];
      list.push(u);
      index.set(u.objectNumber, list);
    }
  }
  return index;
}

export const samePath = (a: readonly UsageStep[], b: readonly UsageStep[]) =>
  a.length === b.length &&
  a.every((s, i) => s.resourceName === b[i]!.resourceName && s.doOrdinal === b[i]!.doOrdinal);

export interface FormUsageEdit {
  /** New instance of the Form to edit (dedicated to the selected usage location) */
  target: mupdf.PDFObject;
  targetObjectNumber: number;
  /** Resource name that the page content's top-level Do now points to */
  pageResourceName: string;
  /** Newly created Form object numbers (the top-level instance and its whole sub-chain) */
  newForms: number[];
  /** Target Form space → page user space */
  toPage: Matrix;
  /** Number of usage locations in the whole document of the original target Form before the change (1 means not shared) */
  originalUsageCount: number;
}

/**
 * Replaces only one Form XObject usage location with a new instance, and erases the text of `formRects` (target Form space,
 * PDF coordinates) inside that instance by redaction. Other usage locations, pages and the original Form object are not changed.
 *
 * Method: draw the top-level Form with the same CTM on a temporary page with the same box and rotation as the original page, and apply
 * annotation-level redaction on that page. On redaction MuPDF creates a new filtered instance of each Form the page uses
 * (the original is unchanged), so that instance is linked only to the selected Do of the original page and the temporary page is deleted.
 * In the original page content only the name operand of that Do changes. For a nested usage location, the parent chain also becomes new instances.
 */
export function redactFormUsage(
  doc: mupdf.PDFDocument,
  usage: XObjectUsage,
  formRects: readonly Rect[],
  options: Readonly<RedactionOptions> = TEXT_REPLACE_REDACTION,
): FormUsageEdit {
  if (usage.subtype !== 'Form') throw new Error(`Form XObject 가 아님: ${usage.subtype}`);
  if (formRects.length === 0) throw new Error('redaction 영역 없음');
  const top = usage.path[0]!;
  const pageObj = doc.findPage(usage.pageIndex);
  const pageRes = pageObj.getInheritable('Resources');
  const topForm = pageRes.get('XObject').get(top.resourceName);
  if (topForm.isNull()) throw new Error(`페이지 리소스에 없음: ${top.resourceName}`);
  const originalUsageCount = usage.objectNumber
    ? (indexXObjectUsages(doc).get(usage.objectNumber)?.length ?? 1)
    : 1;
  const before = doc.countObjects();

  // 1. Temporary page: draw the top-level Form with the same CTM on the same box and rotation as the original page.
  const mediaBox = toRect(pageObj.getInheritable('MediaBox'));
  const rotate = pageObj.getInheritable('Rotate');
  const temp = doc.addPage(
    mediaBox,
    (rotate.isNull() ? 0 : rotate.asNumber()) as mupdf.Rotate,
    { XObject: { X: topForm } },
    `q ${top.ctm.map(formatNumber).join(' ')} cm /X Do Q\n`,
  );
  for (const key of ['CropBox', 'UserUnit']) {
    const v = pageObj.getInheritable(key);
    if (!v.isNull()) temp.put(key, v);
  }
  doc.insertPage(-1, temp);
  const tempIndex = doc.countPages() - 1;
  const instances: mupdf.PDFObject[] = [];
  let tempPage: mupdf.PDFPage | null = null;
  try {
    tempPage = doc.loadPage(tempIndex);
    const toFz = tempPage.getTransform();
    for (const r of formRects) {
      const annot = tempPage.createAnnotation('Redact');
      annot.setRect(transformRect(transformRect(r, usage.toPage), toFz));
      annot.applyRedaction(
        Number(options.blackBoxes),
        options.imageMethod,
        options.lineArtMethod,
        options.textMethod,
      );
      annot.destroy();
    }
    const xobjects = doc.findPage(tempIndex).get('Resources').get('XObject');
    xobjects.forEach((v) => void instances.push(v));
  } finally {
    // Release the page wrapper first, then delete the temporary page.
    tempPage?.destroy();
    doc.deletePage(tempIndex);
  }
  const topInstance = instances[0];
  if (instances.length !== 1 || !topInstance?.isIndirect() || topInstance.asIndirect() < before) {
    throw new Error('redaction 결과 Form 인스턴스를 찾지 못함');
  }

  // 2. Original page: change only the name of the one selected Do and register the new name in the page's own resources.
  const resources = ownResources(doc, pageObj, pageRes);
  const pageResourceName = putUniqueResource(
    ownSubdict(doc, resources, 'XObject'),
    topInstance,
    'FxE',
  );
  replacePageContentName(doc, pageObj, top.nameRange, pageResourceName);

  // 3. Follow the nested path through the new instance chain.
  let target = topInstance;
  for (const step of usage.path.slice(1)) {
    const ops = parseContentOps(readStreamBytes(target)).filter((o) => o.op === 'Do');
    const name = ops[step.doOrdinal]?.operands.at(-1)?.value;
    if (typeof name !== 'string') throw new Error(`인스턴스에서 Do #${step.doOrdinal} 없음`);
    target = target.get('Resources').get('XObject').get(name);
  }
  const newForms: number[] = [];
  for (let n = before; n < doc.countObjects(); n++) {
    const o = doc.newIndirect(n);
    if (o.isStream() && o.get('Subtype').isName() && o.get('Subtype').asName() === 'Form') {
      if (formReachable(topInstance, n)) newForms.push(n);
    }
  }
  return {
    target,
    targetObjectNumber: target.asIndirect(),
    pageResourceName,
    newForms,
    toPage: usage.toPage,
    originalUsageCount,
  };
}

function formReachable(root: mupdf.PDFObject, num: number, seen = new Set<number>()): boolean {
  const n = root.asIndirect();
  if (n === num) return true;
  if (seen.has(n)) return false;
  seen.add(n);
  let found = false;
  root
    .get('Resources')
    .get('XObject')
    .forEach((v) => {
      if (!found && v.isIndirect() && v.get('Subtype').asName() === 'Form') {
        found = formReachable(v, num, seen);
      }
    });
  return found;
}

/** Replaces the name operand in page content (relative to the joined bytes). Only that stream is replaced with a new object. */
function replacePageContentName(
  doc: mupdf.PDFDocument,
  pageObj: mupdf.PDFObject,
  range: [number, number],
  name: string,
): void {
  const content = readPageContent(pageObj);
  const seg = content.segments.findIndex((s) => range[0] >= s.start && range[1] <= s.end);
  if (seg < 0) throw new Error('이름 피연산자가 스트림 경계에 걸침');
  const { start, end } = content.segments[seg]!;
  const local = content.bytes.subarray(start, end);
  const replaced = doc.addStream(
    spliceBytes(local, range[0] - start, range[1] - start, `/${name}`),
    {},
  );
  const contents = pageObj.get('Contents');
  if (contents.isArray()) {
    const arr = doc.newArray();
    contents.resolve().forEach((s, i) => void arr.push(i === seg ? replaced : s));
    pageObj.put('Contents', arr);
  } else {
    pageObj.put('Contents', replaced);
  }
}

/**
 * Wraps the Form content in `q … Q` and appends content after it (Form-space coordinates).
 * A Form is clipped by its BBox, so new content outside the BBox is invisible (the caller checks with `outsideFormBBox`).
 */
export function appendFormContent(form: mupdf.PDFObject, content: string): void {
  const old = form.readStream().asString();
  writeStreamBytes(form, `q\n${old}\nQ\n${content}`);
}

/** Whether rect (Form space) goes outside the Form BBox. */
export function outsideFormBBox(form: mupdf.PDFObject, rect: Rect): boolean {
  const b = toRect(form.get('BBox'));
  return rect[0] < b[0] || rect[1] < b[1] || rect[2] > b[2] || rect[3] > b[3];
}
