import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as mupdf from 'mupdf';
import { resolveStyle } from '../src/edit-style.js';
import { FontState } from '../src/font-assign.js';
import { findParagraph, loadModules, pageContext, reopen } from './helpers/edit-context.js';
import { fallbackFor, loadFallback } from './helpers/edit-driver.js';

/** R-L3(docs/m4-contract.md 1.2): FontState·OriginalFont 의 WASM 자원 해제. */
beforeAll(async () => {
  await loadModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Noto Sans KR 을 Type0 으로 넣은 문서(임베디드라 원본 판정에 렌더 탐침을 쓴다). */
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
  it('탐침 임시 문서와 폴백 mupdf.Font 를 해제하고, 해제 뒤 배정은 예외', () => {
    const doc = notoDoc('가나다 문단');
    const ctx = pageContext(doc, 0);
    const p = findParagraph(ctx, '가나다');
    const style = resolveStyle(ctx, p.chars[0]!)!;
    const state = new FontState(doc, fallbackFor(doc));
    const orig = state.original(style, ctx.map);
    expect(orig.encode('가')).not.toBeNull(); // 탐침 임시 문서를 만든다
    expect(state.fallbackHas('한')).toBe(true); // 폴백 mupdf.Font 를 만든다

    const docDestroy = vi.spyOn(mupdf.PDFDocument.prototype, 'destroy');
    const fontDestroy = vi.spyOn(mupdf.Font.prototype, 'destroy');
    state.dispose();
    expect(docDestroy).toHaveBeenCalledTimes(1);
    expect(fontDestroy).toHaveBeenCalledTimes(1);
    expect(state.originalByKey(orig.key)).toBeUndefined();

    state.dispose(); // 두 번째는 아무것도 하지 않는다
    expect(docDestroy).toHaveBeenCalledTimes(1);
    expect(fontDestroy).toHaveBeenCalledTimes(1);
    expect(() => state.original(style, ctx.map)).toThrow('해제');
    expect(() => state.fallbackFace()).toThrow('해제');
    // 원본 문서는 그대로 쓸 수 있다.
    expect(doc.countPages()).toBe(1);
  });

  it('폴백·탐침을 만들지 않았으면 해제할 것이 없다', () => {
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
  it('여러 번 불러도 되고, 해제 뒤 새 글자는 탐침을 다시 만들어 판정한다', () => {
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
