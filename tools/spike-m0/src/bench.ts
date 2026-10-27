// core must be imported before mupdf so the WASM heap measurement object is attached.
import { openPdf } from '@pdf-editor/core';
import * as mupdf from 'mupdf';
import {
  addPageFontResource,
  appendPageContent,
  decideSaveMethod,
  embedFont,
  redactRegions,
  serializeTextBlock,
} from '@pdf-editor/pdf-ops';
import type { ChangeKind, SaveMethod } from '@pdf-editor/shared-types';
import { TARGET_RECT, TARGET_TEXT_BOX } from './fixture.js';
import { layoutParagraph } from './layout.js';
import { REPLACEMENT_TEXT } from './spike.js';

export interface BenchResult {
  pages: number;
  inputBytes: number;
  method: SaveMethod;
  options: string;
  canBeSavedIncrementally: boolean;
  subsetMs: number | null;
  saveMs: number;
  outputBytes: number;
  output: Uint8Array;
}

/** Replace a paragraph on page 1 (same edit as the spike): redaction → fallback font embedding → new content stream. */
export function applyBenchEdit(doc: mupdf.PDFDocument, fontBytes: Uint8Array): void {
  let page = doc.loadPage(0);
  redactRegions(page, [TARGET_RECT]);
  page = doc.loadPage(0);
  const embedded = embedFont(doc, 'NotoSansKR', fontBytes);
  const inv = mupdf.Matrix.invert(page.getTransform());
  const box = mupdf.Rect.transform(TARGET_TEXT_BOX, inv);
  const layout = layoutParagraph({
    font: embedded.font,
    text: REPLACEMENT_TEXT,
    fontSize: 11,
    lineHeight: 1.4,
    ascent: 0.88,
    box: [box[0], box[1], box[2], box[3]],
  });
  const name = addPageFontResource(doc, page, embedded.ref);
  appendPageContent(
    doc,
    page,
    serializeTextBlock({ fontResource: name, fontSize: 11, color: [0, 0, 0], lines: layout.lines }),
  );
}

/** Full save after replacing a paragraph on page 1 of a large document (same edit as the spike). */
export function runBenchFull(
  bytes: Uint8Array,
  fontBytes: Uint8Array,
  onPhase: (p: string) => void,
): BenchResult {
  const doc = openPdf(bytes);
  onPhase('open');
  applyBenchEdit(doc, fontBytes);
  onPhase('edit');
  const changes: ChangeKind[] = ['redaction', 'font-embed', 'content-stream'];
  const can = doc.canBeSavedIncrementally();
  const t0 = performance.now();
  doc.subsetFonts();
  const subsetMs = performance.now() - t0;
  onPhase('subset-fonts');
  const decision = decideSaveMethod(changes, can);
  const t1 = performance.now();
  const buf = doc.saveToBuffer(decision.options);
  const saveMs = performance.now() - t1;
  const output = buf.asUint8Array().slice();
  buf.destroy();
  onPhase('save');
  const pages = doc.countPages();
  doc.destroy();
  return {
    pages,
    inputBytes: bytes.byteLength,
    method: decision.method,
    options: decision.options,
    canBeSavedIncrementally: can,
    subsetMs,
    saveMs,
    outputBytes: output.byteLength,
    output,
  };
}

/** Control: add just one annotation to the same document and save incrementally. */
export function runBenchIncremental(bytes: Uint8Array, onPhase: (p: string) => void): BenchResult {
  const doc = openPdf(bytes);
  onPhase('open');
  const annot = doc.loadPage(0).createAnnotation('Text');
  annot.setRect([20, 20, 40, 40]);
  annot.setContents('M0 bench');
  annot.update();
  onPhase('edit');
  const can = doc.canBeSavedIncrementally();
  const decision = decideSaveMethod(['annotation'], can);
  const t1 = performance.now();
  const buf = doc.saveToBuffer(decision.options);
  const saveMs = performance.now() - t1;
  const output = buf.asUint8Array().slice();
  buf.destroy();
  onPhase('save');
  const pages = doc.countPages();
  doc.destroy();
  return {
    pages,
    inputBytes: bytes.byteLength,
    method: decision.method,
    options: decision.options,
    canBeSavedIncrementally: can,
    subsetMs: null,
    saveMs,
    outputBytes: output.byteLength,
    output,
  };
}
