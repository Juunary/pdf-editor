/**
 * Text removal based on the source linkage (SourceMap) (A7-2 design verification, docs/m1-decisions.md).
 *
 * MuPDF page redaction re-serializes the whole page content and loses original byte positions, and on pages with ActualText
 * it moves lines that were not edited (docs/m0-corpus-recheck.md C2). This function replaces only the bytes of the text-showing operations (Tj, TJ, ', ") to be erased
 * with a single-number TJ having the same total advance. Since the text matrix (Tm) ends at the same place as before,
 * the positions of characters that follow in the same BT do not change, and the rest of the stream's bytes remain as they are.
 *
 * The advance is computed from spec widths (`PdfFont.advanceSpec`, real-valued /Widths and /W). MuPDF rounds widths to integers, so
 * with fractional-width fonts the later characters in a MuPDF render move by the rounding error, while in viewers that draw per the spec they stay put.
 *
 * Scope: removal of whole horizontal-writing operations in page content. The following are skipped and a reason code (`RemoveSkipCode`, explanation in detail)
 * is returned: operations inside a Form XObject (M3 paragraph editing uses the Form duplication path, paragraph-edit.ts), clip text (Tr 4–7), vertical writing,
 * Type3, fonts with uncertain widths or MuPDF substitute fonts, codes without CID mapping, Tf size 0 and Tz 0. Erasing only part of an operation and text inside a Form are
 * handled by M3 paragraph editing (edit-plan.ts) with the same analysis (show-ops.ts). The MuPDF redaction fallback path is not used (contract D2).
 *
 * If the content stream is shared with another page's /Contents or another slot of the same /Contents array, that stream is not modified; a copy is
 * made and only this page's slot is switched to the copy.
 */
import type * as mupdf from 'mupdf';
import type { RemoveSkipCode, SourceMap } from '@pdf-editor/shared-types';
import { concatBytes } from './content-stream.js';
import { readStreamBytes, writeStreamBytes } from './mupdf-util.js';
import { FontCache } from './pdf-fonts.js';
import { analyzeShow, isSkip, rewriteShow } from './show-ops.js';

export interface RemoveTextResult {
  /** Replaced operation ids. */
  removed: number[];
  /** Skipped operations and reason codes (detail is an explanation for display to the user). */
  skipped: { opId: number; code: RemoveSkipCode; detail: string }[];
  /** Object number of the rewritten content stream (the number of the newly created copy if the stream is shared). */
  streams: number[];
  /** Record of a shared stream: a copy was made and only this page's slot in /Contents was changed. */
  copied: { contentsIndex: number; from: number; to: number }[];
}

export interface Replacement {
  start: number;
  end: number;
  text: string;
}

/** Replacement group for the same stream and the same /Contents slot. */
interface Group {
  num: number;
  slot: number;
  list: Replacement[];
}

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/** Indirect object number that slot of the page /Contents points to. null if none. */
export function contentsSlotNumber(pageObj: mupdf.PDFObject, slot: number): number | null {
  const contents = pageObj.get('Contents');
  const item = contents.isArray() ? contents.get(slot) : slot === 0 ? contents : null;
  return item?.isIndirect() ? item.asIndirect() : null;
}

/** Number of slots in all page /Contents that point to stream object num (including duplicates within the same array). */
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

/** Changes only slot of this page's /Contents to ref. The array is replaced with a new direct array so an array shared with other pages is not modified. */
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
 * Applies a replacement list based on original bytes all at once (contract D2). An insertion at the same position (empty range) goes before the replacement at that position,
 * and insertions at the same position go in list order. Throws if ranges overlap.
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

/** Erases the text-showing operations of the SourceMap (replaced with an empty TJ of the same advance). */
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
    // Replacing with an empty TJ would leave no glyphs in the clip path, so content drawn inside the clip would show (MuPDF: no clip) or differ per viewer.
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

  // Compute and validate everything before writing (so a mid-way failure does not change only part of it).
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
