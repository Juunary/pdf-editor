import * as mupdf from 'mupdf';
import type { Rect } from '@pdf-editor/shared-types';
import { concatBytes, parseContentOps, spliceBytes } from './content-stream.js';
import { readStreamBytes, writeStreamBytes } from './mupdf-util.js';
import { ownResources, ownSubdict, putUniqueResource } from './page-content.js';
import { TEXT_REPLACE_REDACTION, type RedactionOptions } from './redact.js';
import { formatNumber } from './text-ops.js';

/** PDF 행렬 [a b c d e f]. 점 변환은 행 벡터 기준 p' = p × M (MuPDF `Matrix.concat` 과 같은 규약). */
export type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export interface UsageStep {
  /** 컨테이너(페이지 또는 상위 Form) XObject 리소스 이름 */
  resourceName: string;
  /** 컨테이너 콘텐츠의 Do 연산자 중 순번(0부터) */
  doOrdinal: number;
  /** Do 이름 피연산자 바이트 범위. 페이지는 Contents 배열을 LF 로 이어붙인 바이트 기준 */
  nameRange: [number, number];
  /** 이 Do 시점 CTM(컨테이너 공간 → 페이지 사용자 공간) */
  ctm: Matrix;
}

export interface XObjectUsage {
  pageIndex: number;
  /** 페이지에서 이 사용 위치까지의 Do 체인. 길이 1 = 페이지가 직접 그림 */
  path: UsageStep[];
  /** 간접 객체 번호. 직접 객체면 0 */
  objectNumber: number;
  subtype: string;
  /** Form: Form 공간 → 페이지 사용자 공간(/Matrix × CTM). Image: 단위 정사각형 → 페이지 사용자 공간 */
  toPage: Matrix;
  /** Form BBox(Image 는 단위 정사각형)의 페이지 사용자 공간 외접 사각형(PDF 좌표, y 위 방향) */
  pageBox: Rect;
}

export interface UsageWalkOptions {
  /** Form 재귀 깊이 상한(페이지 = 0). 기본 8 */
  maxDepth?: number;
}

function toMatrix(obj: mupdf.PDFObject): Matrix {
  if (!obj.isArray() || obj.length !== 6) return [...IDENTITY];
  return [0, 1, 2, 3, 4, 5].map((i) => obj.get(i).asNumber()) as Matrix;
}

/**
 * PDF 사각형 배열 → 정규화한 Rect(x0 ≤ x1, y0 ≤ y1). 실제 문서의 /BBox·/MediaBox 는 `[0 792 612 0]` 처럼
 * 뒤집힌 경우가 있다(docs/m0-corpus-recheck.md C3, 시험한 Form 9개 중 4개). MuPDF Rect.transform 은 뒤집힌
 * 사각형을 빈 사각형으로 다루므로 변환·비교 전에 정규화한다(PDF 32000-1 7.9.5).
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
  /** Contents 배열 원소(또는 단일 스트림)별 이어붙인 바이트 구간 */
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

/** 페이지 콘텐츠의 XObject 사용 위치(중첩 Form 포함). 순서 = 콘텐츠 실행 순서(깊이 우선). */
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

/** 문서 전체 XObject 사용 위치를 객체 번호별로 모은다(직접 객체 제외). 2개 이상이면 공유 객체다. */
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
  /** 편집 대상 Form 의 새 인스턴스(선택 사용 위치 전용) */
  target: mupdf.PDFObject;
  targetObjectNumber: number;
  /** 페이지 콘텐츠의 최상위 Do 가 새로 가리키는 리소스 이름 */
  pageResourceName: string;
  /** 새로 생긴 Form 객체 번호(최상위 인스턴스와 그 하위 체인 전체) */
  newForms: number[];
  /** 대상 Form 공간 → 페이지 사용자 공간 */
  toPage: Matrix;
  /** 바꾸기 전 대상 원본 Form 의 문서 전체 사용 위치 수(1 이면 공유 아님) */
  originalUsageCount: number;
}

/**
 * Form XObject 사용 위치 1곳만 새 인스턴스로 바꾸고, 그 인스턴스 안의 `formRects`(대상 Form 공간,
 * PDF 좌표) 텍스트를 redaction 으로 지운다. 다른 사용 위치·페이지와 원본 Form 객체는 바꾸지 않는다.
 *
 * 방법: 원 페이지와 같은 박스·회전의 임시 페이지에 최상위 Form 을 같은 CTM 으로 그리고, 그 페이지에서
 * 주석 단위 redaction 을 적용한다. MuPDF 는 redaction 시 페이지가 쓰는 Form 마다 필터링한 새 인스턴스를
 * 만들므로(원본 미변경), 그 인스턴스를 원 페이지의 선택 Do 1곳에만 연결하고 임시 페이지를 지운다.
 * 원 페이지 콘텐츠는 해당 Do 의 이름 피연산자만 바뀐다. 중첩 사용 위치면 상위 체인도 함께 새 인스턴스가 된다.
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

  // 1. 임시 페이지: 원 페이지와 같은 박스·회전에서 최상위 Form 을 같은 CTM 으로 그린다.
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
    // 쪽 래퍼를 먼저 놓고 임시 쪽을 지운다.
    tempPage?.destroy();
    doc.deletePage(tempIndex);
  }
  const topInstance = instances[0];
  if (instances.length !== 1 || !topInstance?.isIndirect() || topInstance.asIndirect() < before) {
    throw new Error('redaction 결과 Form 인스턴스를 찾지 못함');
  }

  // 2. 원 페이지: 선택 Do 1곳의 이름만 바꾸고 새 이름을 페이지 전용 리소스에 등록한다.
  const resources = ownResources(doc, pageObj, pageRes);
  const pageResourceName = putUniqueResource(
    ownSubdict(doc, resources, 'XObject'),
    topInstance,
    'FxE',
  );
  replacePageContentName(doc, pageObj, top.nameRange, pageResourceName);

  // 3. 중첩 경로를 새 인스턴스 체인에서 따라간다.
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

/** 페이지 콘텐츠(이어붙인 바이트 기준) 이름 피연산자를 바꾼다. 해당 스트림만 새 객체로 교체한다. */
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
 * Form 콘텐츠를 `q … Q` 로 감싸고 뒤에 content 를 붙인다(Form 공간 좌표).
 * Form 은 BBox 로 잘리므로 새 콘텐츠가 BBox 밖이면 보이지 않는다(호출자가 `outsideFormBBox` 로 확인).
 */
export function appendFormContent(form: mupdf.PDFObject, content: string): void {
  const old = form.readStream().asString();
  writeStreamBytes(form, `q\n${old}\nQ\n${content}`);
}

/** rect(Form 공간)가 Form BBox 를 벗어나는지. */
export function outsideFormBBox(form: mupdf.PDFObject, rect: Rect): boolean {
  const b = toRect(form.get('BBox'));
  return rect[0] < b[0] || rect[1] < b[1] || rect[2] > b[2] || rect[3] > b[3];
}
