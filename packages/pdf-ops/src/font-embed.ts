import * as mupdf from 'mupdf';

export interface EmbeddedFont {
  font: mupdf.Font;
  /** Type0 폰트 사전 간접 참조. */
  ref: mupdf.PDFObject;
}

/**
 * 폰트 바이트를 실제로 포함해 Type0(Identity-H) 폰트로 추가한다(PLAN.md 3.3).
 * `addCJKFont` 는 폰트 바이트를 포함하지 않으므로 쓰지 않는다.
 * 서브셋은 저장 직전 `doc.subsetFonts()` 로 만든다.
 */
export function embedFont(
  doc: mupdf.PDFDocument,
  name: string,
  bytes: Uint8Array | ArrayBuffer,
): EmbeddedFont {
  const font = new mupdf.Font(name, bytes);
  return { font, ref: doc.addFont(font) };
}

/** 폰트에 글리프가 없는 코드포인트(`encodeCharacter` = 0). 공백류 제외. */
export function missingCodepoints(font: mupdf.Font, text: string): number[] {
  const missing = new Set<number>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (/\s/.test(ch)) continue;
    if (font.encodeCharacter(cp) === 0) missing.add(cp);
  }
  return [...missing];
}
