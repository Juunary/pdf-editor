/**
 * Mapping between paragraph text offsets and PageModel characters (M3 start state 5.3, M4 cell line joining). Does not read the document.
 */
import type { LayoutParagraph } from '@pdf-editor/shared-types';

/** Original paragraph text offset → character index (synthetic space is -1). Aligns paragraph text with character text from the start. */
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
      // Skip whitespace characters trimmed at line ends and empty characters.
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
      // Non-matching character (U+FFFD etc.): advance one position at a time.
      out[o] = ci;
      o++;
      k++;
    } else o++;
  }
  return out;
}
