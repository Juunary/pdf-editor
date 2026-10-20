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
 * 범위: 페이지 콘텐츠의 가로쓰기 연산 전체 제거. 다음은 건너뛰고 사유 코드(`RemoveSkipCode`, 설명은 detail)를
 * 돌려준다: Form XObject 안 연산(M3 문단 편집은 Form 복제 경로, paragraph-edit.ts), 클립 텍스트(Tr 4–7), 세로쓰기,
 * Type3, 폰트 폭 불확실·MuPDF 대체 폰트, CID 매핑 없는 코드, Tf 크기 0·Tz 0. 연산 일부만 지우기와 Form 안 텍스트는
 * M3 문단 편집(edit-plan.ts)이 같은 분석(show-ops.ts)으로 처리한다. MuPDF redaction 대체 경로는 쓰지 않는다(계약 D2).
 *
 * 콘텐츠 스트림을 다른 쪽 /Contents 나 같은 /Contents 배열의 다른 칸과 공유하면 그 스트림을 고치지 않고 사본을
 * 만들어 이 쪽의 해당 칸만 사본으로 바꾼다.
 */
import type * as mupdf from 'mupdf';
import type { RemoveSkipCode, SourceMap } from '@pdf-editor/shared-types';
import { concatBytes } from './content-stream.js';
import { readStreamBytes, writeStreamBytes } from './mupdf-util.js';
import { FontCache } from './pdf-fonts.js';
import { analyzeShow, isSkip, rewriteShow } from './show-ops.js';

export interface RemoveTextResult {
  /** 바꾼 연산 id. */
  removed: number[];
  /** 건너뛴 연산과 사유 코드(detail 은 사용자 표시용 설명). */
  skipped: { opId: number; code: RemoveSkipCode; detail: string }[];
  /** 다시 쓴 콘텐츠 스트림 객체 번호(공유 스트림이면 새로 만든 사본 번호). */
  streams: number[];
  /** 공유 스트림이라 사본을 만들어 이 쪽 /Contents 의 해당 칸만 바꾼 기록. */
  copied: { contentsIndex: number; from: number; to: number }[];
}

export interface Replacement {
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

/** 쪽 /Contents 의 칸 slot 이 가리키는 간접 객체 번호. 없으면 null. */
export function contentsSlotNumber(pageObj: mupdf.PDFObject, slot: number): number | null {
  const contents = pageObj.get('Contents');
  const item = contents.isArray() ? contents.get(slot) : slot === 0 ? contents : null;
  return item?.isIndirect() ? item.asIndirect() : null;
}

/** 모든 쪽 /Contents 에서 스트림 객체 num 을 가리키는 칸 수(같은 배열 안 중복 포함). */
export function contentsUseCount(doc: mupdf.PDFDocument, num: number): number {
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
export function replaceContentsSlot(
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

/**
 * 원본 바이트 기준 교체 목록을 한 번에 적용한다(계약 D2). 같은 위치의 삽입(빈 범위)은 그 위치의 교체보다 먼저,
 * 같은 위치 삽입끼리는 목록 순서대로 들어간다. 범위가 겹치면 예외.
 */
export function applyReplacements(bytes: Uint8Array, list: readonly Replacement[]): Uint8Array {
  list = list
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.start - b.r.start || a.r.end - b.r.end || a.i - b.i)
    .map((x) => x.r);
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
    const skip = (code: RemoveSkipCode, detail: string) =>
      result.skipped.push({ opId: id, code, detail });
    if (!op || op.kind !== 'text-show' || !op.text) {
      skip('not-text-show', '텍스트 표시 연산 아님');
      continue;
    }
    if (op.formPath.length > 0 || op.stream.contentsIndex === null) {
      skip('in-form', 'Form XObject 안 연산(문단 편집의 Form 복제 경로에서 처리)');
      continue;
    }
    if (op.limits.includes('spans-stream-boundary') || op.limits.includes('tokenizer-error')) {
      skip('op-limit', `편집 제한: ${op.limits.join(', ')}`);
      continue;
    }
    // 빈 TJ 로 바꾸면 클립 경로에 글리프가 없어져 클립 안 그림이 드러나거나(MuPDF: 클립 없음) 뷰어마다 다르다.
    if (op.limits.includes('clip-text') || op.text.renderMode >= 4) {
      skip('clip-text', `클립 텍스트(Tr ${op.text.renderMode})`);
      continue;
    }
    if (op.limits.includes('font-encoding-unresolved')) {
      skip('font-encoding-unresolved', '편집 제한: font-encoding-unresolved');
      continue;
    }
    const fontObj = fonts ? fonts.get(op.text.fontResource) : null;
    if (!fontObj?.isDictionary()) {
      skip('no-font-resource', `폰트 리소스 없음: ${op.text.fontResource}`);
      continue;
    }
    const bytes = loadStream(op.stream.objectNumber);
    const opBytes = bytes.subarray(op.range[0], op.range[1]);
    const a = analyzeShow(op, opBytes, cache.load(fontObj));
    if (isSkip(a)) {
      skip(a.code, a.detail);
      continue;
    }
    const text = rewriteShow(
      op,
      opBytes,
      a,
      a.glyphs.map(() => true),
    );
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
      writeStreamBytes(doc.newIndirect(w.group.num), w.bytes);
      result.streams.push(w.group.num);
    }
  }
  return result;
}
