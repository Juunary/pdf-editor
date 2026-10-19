import * as mupdf from 'mupdf';
import { glyphHex } from './text-ops.js';

export interface EmbeddedFont {
  font: mupdf.Font;
  /** Type0 폰트 사전 간접 참조. */
  ref: mupdf.PDFObject;
}

/**
 * 폰트 바이트를 실제로 포함해 Type0(Identity-H) 폰트로 추가한다(PLAN.md 3.3).
 * `addCJKFont` 는 폰트 바이트를 포함하지 않으므로 쓰지 않는다.
 *
 * 서브셋: `subsetGids` 를 주면 그 글리프만 남긴 바이트(`subsetFontBytes`)를 넣는다. 편집 중인 문서에서
 * `doc.subsetFonts()` 는 부르지 않는다. MuPDF 1.28.1 은 문서 전체 폰트를 다시 서브셋하며 원본 단순 폰트의
 * `/Widths` 를 정수로 반올림해 편집하지 않은 쪽 표시를 바꾼다(docs/m0-corpus-recheck.md C1, A7-1).
 */
export function embedFont(
  doc: mupdf.PDFDocument,
  name: string,
  bytes: Uint8Array | ArrayBuffer,
  options: { subsetGids?: Iterable<number> } = {},
): EmbeddedFont {
  const data = options.subsetGids ? subsetFontBytes(name, bytes, options.subsetGids) : bytes;
  const font = new mupdf.Font(name, data);
  return { font, ref: doc.addFont(font) };
}

/**
 * 폴백 폰트만 서브셋한다(A7-1). 별도 임시 문서에 폰트를 Type0(Identity-H)로 넣고 `gids` 만 그린 뒤 그 임시
 * 문서에서 `subsetFonts()` 를 실행해 줄어든 FontFile2 바이트를 돌려준다. 편집 중인 문서는 건드리지 않는다.
 * MuPDF 의 CID TrueType 서브셋은 glyph id 를 유지한다(쓰지 않는 글리프만 비움). 그래서 원래 폰트로 계산한
 * Identity-H 콘텐츠의 gid 가 서브셋 폰트에서도 그대로 유효하다(테스트로 고정).
 */
export function subsetFontBytes(
  name: string,
  bytes: Uint8Array | ArrayBuffer,
  gids: Iterable<number>,
): Uint8Array {
  const unique = [...new Set(gids)].filter((g) => g > 0).sort((a, b) => a - b);
  const temp = new mupdf.PDFDocument();
  try {
    const ref = temp.addFont(new mupdf.Font(name, bytes));
    const shown = unique.length > 0 ? `<${glyphHex(unique)}> Tj` : '';
    temp.insertPage(
      -1,
      temp.addPage([0, 0, 100, 100], 0, { Font: { F: ref } }, `BT /F 10 Tf 0 0 Td ${shown} ET`),
    );
    temp.subsetFonts();
    const file = ref.get('DescendantFonts').get(0).get('FontDescriptor').get('FontFile2');
    if (!file.isStream()) throw new Error(`서브셋 실패: FontFile2 없음(${name})`);
    const buffer = file.readStream();
    try {
      return buffer.asUint8Array().slice();
    } finally {
      buffer.destroy();
    }
  } finally {
    temp.destroy();
  }
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
