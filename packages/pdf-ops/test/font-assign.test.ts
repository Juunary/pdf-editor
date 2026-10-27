import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as mupdf from 'mupdf';
import { resolveStyle } from '../src/edit-style.js';
import { FontState } from '../src/font-assign.js';
import { findParagraph, loadModules, pageContext, reopen } from './helpers/edit-context.js';
import { fallbackFor, loadFallback } from './helpers/edit-driver.js';

/** R-L3 (docs/m4-contract.md 1.2): release of WASM resources of FontState and OriginalFont. */
beforeAll(async () => {
  await loadModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A document with Noto Sans KR embedded as Type0 (embedded, so original classification uses a render probe). */
function notoDoc(text: string): mupdf.PDFDocument {
  const font = new mupdf.Font('NotoSansKR', loadFallback());
  const src = new mupdf.PDFDocument();
  const N = src.addFont(font);
  const hexs = [...text]
    .map((c) => font.encodeCharacter(c.codePointAt(0)!).toString(16).padStart(4, '0'))
    .join('');
  src.insertPage(
    -1,
    src.addPage([0, 0, 400, 300], 0, { Font: { N } }, `BT /N 14 Tf 50 200 Td <${hexs}> Tj ET`),
  );
  font.destroy();
  return reopen(src);
}

describe('R-L3 FontState.dispose', () => {
  it('releases the probe temporary document and the fallback mupdf.Font; assignment after release throws', () => {
    const doc = notoDoc('가나다 문단');
    const ctx = pageContext(doc, 0);
    const p = findParagraph(ctx, '가나다');
    const style = resolveStyle(ctx, p.chars[0]!)!;
    const state = new FontState(doc, fallbackFor(doc));
    const orig = state.original(style, ctx.map);
    expect(orig.encode('가')).not.toBeNull(); // creates the probe temporary document
    expect(state.fallbackHas('한')).toBe(true); // creates the fallback mupdf.Font

    const docDestroy = vi.spyOn(mupdf.PDFDocument.prototype, 'destroy');
    const fontDestroy = vi.spyOn(mupdf.Font.prototype, 'destroy');
    state.dispose();
    expect(docDestroy).toHaveBeenCalledTimes(1);
    expect(fontDestroy).toHaveBeenCalledTimes(1);
    expect(state.originalByKey(orig.key)).toBeUndefined();

    state.dispose(); // the second call does nothing
    expect(docDestroy).toHaveBeenCalledTimes(1);
    expect(fontDestroy).toHaveBeenCalledTimes(1);
    expect(() => state.original(style, ctx.map)).toThrow('해제');
    expect(() => state.fallbackFace()).toThrow('해제');
    // The original document remains usable.
    expect(doc.countPages()).toBe(1);
  });

  it('nothing to release if no fallback or probe was created', () => {
    const doc = notoDoc('가나다');
    const state = new FontState(doc, fallbackFor(doc));
    const docDestroy = vi.spyOn(mupdf.PDFDocument.prototype, 'destroy');
    const fontDestroy = vi.spyOn(mupdf.Font.prototype, 'destroy');
    state.dispose();
    expect(docDestroy).not.toHaveBeenCalled();
    expect(fontDestroy).not.toHaveBeenCalled();
  });
});

describe('R-L3 OriginalFont.destroy', () => {
  it('can be called multiple times; after release, a new character recreates the probe for classification', () => {
    const doc = notoDoc('가나다 문단');
    const ctx = pageContext(doc, 0);
    const style = resolveStyle(ctx, findParagraph(ctx, '가나다').chars[0]!)!;
    const state = new FontState(doc, fallbackFor(doc));
    const orig = state.original(style, ctx.map);
    expect(orig.encode('가')).not.toBeNull();
    orig.destroy();
    orig.destroy();
    expect(orig.encode('나')).not.toBeNull();
    state.dispose();
  });
});
