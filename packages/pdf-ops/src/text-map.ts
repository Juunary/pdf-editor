/**
 * 문단 텍스트 위치 ↔ PageModel 글자 대응(M3 시작 상태 5.3, M4 셀 줄 잇기). 문서를 읽지 않는다.
 */
import type { LayoutParagraph } from '@pdf-editor/shared-types';

/** 원 문단 텍스트 위치 → 글자 인덱스(합성 공백 -1). 문단 텍스트와 글자 텍스트를 앞에서부터 맞춘다. */
export function offsetMap(
  paragraph: LayoutParagraph,
  chars: readonly { text: string }[],
): number[] {
  const text = paragraph.text;
  const out = new Array<number>(text.length).fill(-1);
  let k = 0;
  const list = paragraph.chars;
  for (let o = 0; o < text.length;) {
    while (k < list.length) {
      const t = chars[list[k]!]?.text ?? '';
      if (t !== '' && text.startsWith(t, o)) break;
      // 줄 끝에서 지운 공백 글자·빈 글자는 건너뛴다.
      if (t.trim() === '') {
        k++;
        continue;
      }
      break;
    }
    const ci = list[k];
    const t = ci !== undefined ? (chars[ci]?.text ?? '') : '';
    if (ci !== undefined && t !== '' && text.startsWith(t, o)) {
      for (let j = 0; j < t.length; j++) out[o + j] = ci;
      o += t.length;
      k++;
    } else if (/\s/u.test(text[o]!)) {
      o++;
    } else if (ci !== undefined) {
      // 맞지 않는 글자(U+FFFD 등): 한 칸씩 맞춘다.
      out[o] = ci;
      o++;
      k++;
    } else o++;
  }
  return out;
}
