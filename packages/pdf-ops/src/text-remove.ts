/**
 * 원본 연결 정보(SourceMap) 기반 텍스트 제거(A7-2 설계 검증, docs/m1-decisions.md).
 *
 * MuPDF 페이지 redaction 은 쪽 콘텐츠 전체를 다시 직렬화해 원본 바이트 위치를 잃고, ActualText 가 있는 쪽에서
 * 편집하지 않은 줄을 옮긴다(docs/m0-corpus-recheck.md C2). 이 함수는 지울 텍스트 표시 연산(Tj·TJ·'·")의
 * 바이트만, 같은 총 전진량을 가진 숫자 하나짜리 TJ 로 바꾼다. 텍스트 행렬(Tm)이 원래와 같은 자리에서 끝나므로
 * 같은 BT 안 뒤따르는 글자의 위치가 바뀌지 않고, 스트림의 나머지 바이트는 그대로 남는다.
 *
 * 범위(현재): 페이지 콘텐츠의 가로쓰기 연산 전체 제거. Form XObject 안 연산(인스턴스 경로 사용), 세로쓰기,
 * Tf 크기 0·Tz 0, 연산 일부만 지우기는 건너뛰고 사유를 돌려준다.
 */
import type * as mupdf from 'mupdf';
import type { SourceMap, SourceOp } from '@pdf-editor/shared-types';
import { concatBytes, parseContentOps } from './content-stream.js';
import { FontCache } from './pdf-fonts.js';
import { formatNumber } from './text-ops.js';

export interface RemoveTextResult {
  /** 바꾼 연산 id. */
  removed: number[];
  /** 건너뛴 연산과 사유. */
  skipped: { opId: number; reason: string }[];
  /** 다시 쓴 콘텐츠 스트림 객체 번호. */
  streams: number[];
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/** 연산이 끝났을 때의 가로 전진량(텍스트 공간, Th 포함). 계산할 수 없으면 사유 문자열. */
function displacement(
  op: SourceOp,
  opBytes: Uint8Array,
  cache: FontCache,
  fontObj: mupdf.PDFObject,
): number | string {
  const t = op.text!;
  if (t.fontSize === 0) return 'Tf 크기 0';
  if (t.horizontalScale === 0) return 'Tz 0';
  const font = cache.load(fontObj);
  if (font.wmode === 1) return '세로쓰기';
  if (font.type3Matrix) return 'Type3 폰트';
  if (font.unresolved.length > 0) return `폰트 폭 불확실: ${font.unresolved.join('; ')}`;
  const singleByte = font.subtype !== 'Type0';
  let d = 0;
  for (const g of t.glyphs) {
    const cid = font.cid(g.code);
    if (cid < 0) continue;
    d +=
      ((font.advance(cid) / 1000) * t.fontSize +
        t.charSpacing +
        (singleByte && g.code === 32 ? t.wordSpacing : 0)) *
      t.horizontalScale;
  }
  if (op.op === 'TJ') {
    const [parsed] = parseContentOps(opBytes);
    for (const tok of parsed?.operands ?? []) {
      if (tok.kind === 'number')
        d += (-(tok.value as number) / 1000) * t.fontSize * t.horizontalScale;
    }
  }
  return d;
}

/** 연산 바이트를 같은 전진량의 빈 TJ 로 바꿀 텍스트. */
function replacementText(op: SourceOp, opBytes: Uint8Array, n: number): string {
  const tj = `[${formatNumber(n)}] TJ`;
  if (op.op === 'Tj' || op.op === 'TJ') return tj;
  if (op.op === "'") return `T* ${tj}`;
  // `aw ac string "` → `aw Tw ac Tc T* [n] TJ`(피연산자 원문 유지)
  const [parsed] = parseContentOps(opBytes);
  const nums = (parsed?.operands ?? []).filter((x) => x.kind === 'number');
  const src = (tok: { start: number; end: number }) =>
    String.fromCharCode(...opBytes.subarray(tok.start, tok.end));
  return `${src(nums[0]!)} Tw ${src(nums[1]!)} Tc T* ${tj}`;
}

/** SourceMap 의 텍스트 표시 연산들을 지운다(같은 전진량의 빈 TJ 로 교체). */
export function removeTextShowOps(
  doc: mupdf.PDFDocument,
  map: SourceMap,
  opIds: Iterable<number>,
): RemoveTextResult {
  const result: RemoveTextResult = { removed: [], skipped: [], streams: [] };
  const page = doc.findPage(map.pageIndex);
  const fonts = page.getInheritable('Resources').get('Font');
  const cache = new FontCache(doc);
  const byStream = new Map<number, Replacement[]>();
  const streamBytes = new Map<number, Uint8Array>();
  const loadStream = (num: number): Uint8Array => {
    let b = streamBytes.get(num);
    if (!b) {
      const buf = doc.newIndirect(num).readStream();
      b = buf.asUint8Array().slice();
      buf.destroy();
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
    if (op.formPath.length > 0) {
      skip('Form XObject 안 연산(인스턴스 경로 사용)');
      continue;
    }
    if (op.limits.includes('spans-stream-boundary') || op.limits.includes('tokenizer-error')) {
      skip(`편집 제한: ${op.limits.join(', ')}`);
      continue;
    }
    const fontObj = fonts.get(op.text.fontResource);
    if (fontObj.isNull()) {
      skip(`폰트 리소스 없음: ${op.text.fontResource}`);
      continue;
    }
    const bytes = loadStream(op.stream.objectNumber);
    const opBytes = bytes.subarray(op.range[0], op.range[1]);
    const d = displacement(op, opBytes, cache, fontObj);
    if (typeof d === 'string') {
      skip(d);
      continue;
    }
    const n = (-d / (op.text.fontSize * op.text.horizontalScale)) * 1000;
    const list = byStream.get(op.stream.objectNumber) ?? [];
    list.push({ start: op.range[0], end: op.range[1], text: replacementText(op, opBytes, n) });
    byStream.set(op.stream.objectNumber, list);
    result.removed.push(id);
  }

  for (const [num, list] of byStream) {
    const bytes = streamBytes.get(num)!;
    list.sort((a, b) => a.start - b.start);
    const parts: Uint8Array[] = [];
    let pos = 0;
    for (const r of list) {
      if (r.start < pos) throw new Error(`겹치는 교체 범위: ${r.start}`);
      parts.push(bytes.subarray(pos, r.start), latin1(r.text));
      pos = r.end;
    }
    parts.push(bytes.subarray(pos));
    doc.newIndirect(num).writeStream(concatBytes(parts));
    result.streams.push(num);
  }
  return result;
}
