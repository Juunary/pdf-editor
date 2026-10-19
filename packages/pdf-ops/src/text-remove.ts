/**
 * 원본 연결 정보(SourceMap) 기반 텍스트 제거(A7-2 설계 검증, docs/m1-decisions.md).
 *
 * MuPDF 페이지 redaction 은 쪽 콘텐츠 전체를 다시 직렬화해 원본 바이트 위치를 잃고, ActualText 가 있는 쪽에서
 * 편집하지 않은 줄을 옮긴다(docs/m0-corpus-recheck.md C2). 이 함수는 지울 텍스트 표시 연산(Tj·TJ·'·")의
 * 바이트만, 같은 총 전진량을 가진 숫자 하나짜리 TJ 로 바꾼다. 텍스트 행렬(Tm)이 원래와 같은 자리에서 끝나므로
 * 같은 BT 안 뒤따르는 글자의 위치가 바뀌지 않고, 스트림의 나머지 바이트는 그대로 남는다.
 *
 * 전진량은 명세 폭(`PdfFont.advanceSpec`, 실수 /Widths·/W)으로 계산한다. MuPDF 는 폭을 정수로 반올림하므로
 * 소수 폭 폰트에서는 MuPDF 렌더의 뒤 글자가 반올림 오차만큼 움직이고, 명세대로 그리는 뷰어에서는 그대로다.
 *
 * 범위(현재): 페이지 콘텐츠의 가로쓰기 연산 전체 제거. 다음은 건너뛰고 사유를 돌려준다(호출자는 redaction 대체 경로):
 * Form XObject 안 연산(인스턴스 경로 사용), 클립 텍스트(Tr 4–7), 세로쓰기, Type3, 폰트 폭 불확실·MuPDF 대체 폰트,
 * CID 매핑 없는 코드, Tf 크기 0·Tz 0, 연산 일부만 지우기.
 *
 * 콘텐츠 스트림을 다른 쪽 /Contents 나 같은 /Contents 배열의 다른 칸과 공유하면 그 스트림을 고치지 않고 사본을
 * 만들어 이 쪽의 해당 칸만 사본으로 바꾼다.
 */
import type * as mupdf from 'mupdf';
import type { SourceMap, SourceOp } from '@pdf-editor/shared-types';
import {
  concatBytes,
  decodeStringToken,
  parseContentOpsLenient,
  type Token,
} from './content-stream.js';
import { readStreamBytes } from './mupdf-util.js';
import { FontCache } from './pdf-fonts.js';
import { formatNumber } from './text-ops.js';

export interface RemoveTextResult {
  /** 바꾼 연산 id. */
  removed: number[];
  /** 건너뛴 연산과 사유. */
  skipped: { opId: number; reason: string }[];
  /** 다시 쓴 콘텐츠 스트림 객체 번호(공유 스트림이면 새로 만든 사본 번호). */
  streams: number[];
  /** 공유 스트림이라 사본을 만들어 이 쪽 /Contents 의 해당 칸만 바꾼 기록. */
  copied: { contentsIndex: number; from: number; to: number }[];
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

/** 같은 스트림·같은 /Contents 칸의 교체 묶음. */
interface Group {
  num: number;
  slot: number;
  list: Replacement[];
}

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/** 연산 피연산자. content-interp readOperands 와 같은 선택: 최상위 숫자, 마지막 문자열, 마지막 배열. */
interface OpParts {
  nums: Token[];
  str: Token | null;
  array: Token[] | null;
}

function opParts(tokens: readonly Token[]): OpParts {
  const out: OpParts = { nums: [], str: null, array: null };
  let depth = 0;
  let group: Token[] = [];
  let isArray = false;
  for (const t of tokens) {
    if (depth > 0) {
      if (t.kind === 'array-open' || t.kind === 'dict-open') depth++;
      else if (t.kind === 'array-close' || t.kind === 'dict-close') depth--;
      if (depth === 0) {
        if (isArray) out.array = group;
      } else group.push(t);
      continue;
    }
    if (t.kind === 'array-open' || t.kind === 'dict-open') {
      depth = 1;
      group = [];
      isArray = t.kind === 'array-open';
    } else if (t.kind === 'number') out.nums.push(t);
    else if (t.kind === 'string' || t.kind === 'hexstring') out.str = t;
  }
  return out;
}

/** 텍스트 표시 항목(문자열 토큰·TJ 숫자 조정). 계산할 수 없으면 사유 문자열. */
function showItems(op: SourceOp, parts: OpParts): (Token | number)[] | string {
  if (op.op !== 'TJ') return parts.str ? [parts.str] : [];
  const items: (Token | number)[] = [];
  for (const t of parts.array ?? []) {
    if (t.kind === 'string' || t.kind === 'hexstring') items.push(t);
    else if (t.kind === 'number') items.push(t.value as number);
    // MuPDF 는 배열 안 Tw·Tc 키워드를 실행하지만 명세 밖이라 뷰어마다 다르다.
    else return 'TJ 배열에 문자열·숫자 밖 토큰';
  }
  return items;
}

/** 연산이 끝났을 때의 가로 전진량(텍스트 공간, Th 포함, 명세 폭). 계산할 수 없으면 사유 문자열. */
function displacement(
  op: SourceOp,
  opBytes: Uint8Array,
  parts: OpParts,
  cache: FontCache,
  fontObj: mupdf.PDFObject,
): number | string {
  const t = op.text!;
  if (t.fontSize === 0) return 'Tf 크기 0';
  if (t.horizontalScale === 0) return 'Tz 0';
  const font = cache.load(fontObj);
  if (font.fallbackReason !== undefined) {
    return `MuPDF 대체 폰트(로드 실패: ${font.fallbackReason})`;
  }
  if (font.wmode === 1) return '세로쓰기';
  if (font.type3Matrix) return 'Type3 폰트';
  if (font.unresolved.length > 0) return `폰트 폭 불확실: ${font.unresolved.join('; ')}`;
  const items = showItems(op, parts);
  if (typeof items === 'string') return items;
  let d = 0;
  let count = 0;
  for (const item of items) {
    if (typeof item === 'number') {
      d += (-item / 1000) * t.fontSize * t.horizontalScale;
      continue;
    }
    for (const c of font.decode(decodeStringToken(opBytes, item).data)) {
      count++;
      const cid = font.cid(c.code);
      // MuPDF 는 전진하지 않고, 명세대로 그리는 뷰어는 CID 0 폭으로 전진한다.
      if (cid < 0) return 'CID 매핑 없는 코드(뷰어마다 전진량이 다름)';
      // Tw 는 1바이트 코드 32 에만 적용한다(MuPDF·명세 공통, 폰트 종류 무관).
      const ws = c.length === 1 && c.code === 32 ? t.wordSpacing : 0;
      d += ((font.advanceSpec(cid) / 1000) * t.fontSize + t.charSpacing + ws) * t.horizontalScale;
    }
  }
  if (count !== t.glyphs.length) {
    return `글리프 수 불일치(SourceMap ${t.glyphs.length}, 다시 읽기 ${count})`;
  }
  return d;
}

/** 연산 바이트를 같은 전진량의 빈 TJ 로 바꿀 텍스트. `"` 피연산자가 모자라면 null. */
function replacementText(
  op: SourceOp,
  opBytes: Uint8Array,
  parts: OpParts,
  n: number,
): string | null {
  const tj = `[${formatNumber(n)}] TJ`;
  if (op.op === 'Tj' || op.op === 'TJ') return tj;
  if (op.op === "'") return `T* ${tj}`;
  // `aw ac string "` → `aw Tw ac Tc T* [n] TJ`(피연산자 원문 유지)
  const [aw, ac] = parts.nums;
  if (!aw || !ac) return null;
  const src = (tok: Token) => String.fromCharCode(...opBytes.subarray(tok.start, tok.end));
  return `${src(aw)} Tw ${src(ac)} Tc T* ${tj}`;
}

/** 쪽 /Contents 의 칸 slot 이 가리키는 간접 객체 번호. 없으면 null. */
function contentsSlotNumber(pageObj: mupdf.PDFObject, slot: number): number | null {
  const contents = pageObj.get('Contents');
  const item = contents.isArray() ? contents.get(slot) : slot === 0 ? contents : null;
  return item?.isIndirect() ? item.asIndirect() : null;
}

/** 모든 쪽 /Contents 에서 스트림 객체 num 을 가리키는 칸 수(같은 배열 안 중복 포함). */
function contentsUseCount(doc: mupdf.PDFDocument, num: number): number {
  let n = 0;
  const pages = doc.countPages();
  for (let i = 0; i < pages; i++) {
    const contents = doc.findPage(i).get('Contents');
    if (contents.isArray()) {
      for (let k = 0; k < contents.length; k++) {
        const s = contents.get(k);
        if (s.isIndirect() && s.asIndirect() === num) n++;
      }
    } else if (contents.isIndirect() && contents.asIndirect() === num) n++;
  }
  return n;
}

/** 이 쪽 /Contents 의 칸 slot 만 ref 로 바꾼다. 배열은 새 직접 배열로 바꿔 다른 쪽과 공유하던 배열을 고치지 않는다. */
function replaceContentsSlot(
  doc: mupdf.PDFDocument,
  pageObj: mupdf.PDFObject,
  slot: number,
  ref: mupdf.PDFObject,
): void {
  const contents = pageObj.get('Contents');
  if (!contents.isArray()) {
    pageObj.put('Contents', ref);
    return;
  }
  const arr = doc.newArray();
  for (let k = 0; k < contents.length; k++) arr.push(k === slot ? ref : contents.get(k));
  pageObj.put('Contents', arr);
}

function applyReplacements(bytes: Uint8Array, list: Replacement[]): Uint8Array {
  list.sort((a, b) => a.start - b.start);
  const parts: Uint8Array[] = [];
  let pos = 0;
  for (const r of list) {
    if (r.start < pos) throw new Error(`겹치는 교체 범위: ${r.start}`);
    parts.push(bytes.subarray(pos, r.start), latin1(r.text));
    pos = r.end;
  }
  parts.push(bytes.subarray(pos));
  return concatBytes(parts);
}

/** SourceMap 의 텍스트 표시 연산들을 지운다(같은 전진량의 빈 TJ 로 교체). */
export function removeTextShowOps(
  doc: mupdf.PDFDocument,
  map: SourceMap,
  opIds: Iterable<number>,
): RemoveTextResult {
  const result: RemoveTextResult = { removed: [], skipped: [], streams: [], copied: [] };
  const pageObj = doc.findPage(map.pageIndex);
  const resources = pageObj.getInheritable('Resources');
  const fontsObj = resources.isDictionary() ? resources.get('Font') : null;
  const fonts = fontsObj?.isDictionary() ? fontsObj : null;
  const cache = new FontCache(doc);
  const groups = new Map<string, Group>();
  const streamBytes = new Map<number, Uint8Array>();
  const loadStream = (num: number): Uint8Array => {
    let b = streamBytes.get(num);
    if (!b) {
      b = readStreamBytes(doc.newIndirect(num));
      streamBytes.set(num, b);
    }
    return b;
  };

  for (const id of new Set(opIds)) {
    const op = map.ops[id];
    const skip = (reason: string) => result.skipped.push({ opId: id, reason });
    if (!op || op.kind !== 'text-show' || !op.text) {
      skip('텍스트 표시 연산 아님');
      continue;
    }
    if (op.formPath.length > 0 || op.stream.contentsIndex === null) {
      skip('Form XObject 안 연산(인스턴스 경로 사용)');
      continue;
    }
    if (op.limits.includes('spans-stream-boundary') || op.limits.includes('tokenizer-error')) {
      skip(`편집 제한: ${op.limits.join(', ')}`);
      continue;
    }
    // 빈 TJ 로 바꾸면 클립 경로에 글리프가 없어져 클립 안 그림이 드러나거나(MuPDF: 클립 없음) 뷰어마다 다르다.
    if (op.limits.includes('clip-text') || op.text.renderMode >= 4) {
      skip(`클립 텍스트(Tr ${op.text.renderMode})`);
      continue;
    }
    if (op.limits.includes('font-encoding-unresolved')) {
      skip('편집 제한: font-encoding-unresolved');
      continue;
    }
    const fontObj = fonts ? fonts.get(op.text.fontResource) : null;
    if (!fontObj?.isDictionary()) {
      skip(`폰트 리소스 없음: ${op.text.fontResource}`);
      continue;
    }
    const bytes = loadStream(op.stream.objectNumber);
    const opBytes = bytes.subarray(op.range[0], op.range[1]);
    const parsed = parseContentOpsLenient(opBytes);
    const parsedOp = parsed.ops[0];
    if (parsed.error || parsed.ops.length !== 1 || parsedOp?.op !== op.op) {
      skip('연산 바이트를 다시 읽지 못함');
      continue;
    }
    const parts = opParts(parsedOp.operands);
    if (op.op === '"' && parts.nums.length < 2) {
      skip('" 피연산자 부족');
      continue;
    }
    const d = displacement(op, opBytes, parts, cache, fontObj);
    if (typeof d === 'string') {
      skip(d);
      continue;
    }
    const n = (-d / (op.text.fontSize * op.text.horizontalScale)) * 1000;
    const text = replacementText(op, opBytes, parts, n);
    if (text === null) {
      skip('" 피연산자 부족');
      continue;
    }
    const slot = op.stream.contentsIndex;
    const key = `${op.stream.objectNumber}:${slot}`;
    const group = groups.get(key) ?? { num: op.stream.objectNumber, slot, list: [] };
    group.list.push({ start: op.range[0], end: op.range[1], text });
    groups.set(key, group);
    result.removed.push(id);
  }

  // 쓰기 전에 모두 계산·검증한다(중간 실패로 일부만 바뀌지 않게).
  const writes = [...groups.values()].map((g) => {
    if (contentsSlotNumber(pageObj, g.slot) !== g.num) {
      throw new Error(`SourceMap 이 문서와 다름: /Contents[${g.slot}] ≠ ${g.num} 0 R`);
    }
    return {
      group: g,
      bytes: applyReplacements(streamBytes.get(g.num)!, g.list),
      shared: contentsUseCount(doc, g.num) > 1,
    };
  });
  for (const w of writes) {
    if (w.shared) {
      const copy = doc.addStream(w.bytes, {});
      const to = copy.asIndirect();
      replaceContentsSlot(doc, pageObj, w.group.slot, copy);
      result.streams.push(to);
      result.copied.push({ contentsIndex: w.group.slot, from: w.group.num, to });
    } else {
      doc.newIndirect(w.group.num).writeStream(w.bytes);
      result.streams.push(w.group.num);
    }
  }
  return result;
}
