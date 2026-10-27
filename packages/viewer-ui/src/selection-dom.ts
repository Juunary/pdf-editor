/**
 * The link between the DOM Selection and reading-order caret ranges. The character spans of the text layer are in DOM order = reading order,
 * and `spans[k]` corresponds to ReadingOrder.items[k].
 */

/** Character text node inside a span and the boundary offset. */
function endpoint(span: HTMLElement, atEnd: boolean): [Node, number] {
  const text = span.firstChild;
  if (!text) return [span, 0];
  return [text, atEnd && text.nodeType === Node.TEXT_NODE ? (text as Text).length : 0];
}

/**
 * Makes the caret range [from, to) into a DOM selection and returns the range actually made (after range correction).
 * Clears the selection and returns null if the range is empty.
 */
export function selectInterval(
  selection: Selection,
  spans: readonly HTMLElement[],
  from: number,
  to: number,
): [number, number] | null {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(spans.length, Math.max(from, to));
  if (lo >= hi) {
    selection.removeAllRanges();
    return null;
  }
  const [startNode, startOffset] = endpoint(spans[lo]!, false);
  const [endNode, endOffset] = endpoint(spans[hi - 1]!, true);
  selection.setBaseAndExtent(startNode, startOffset, endNode, endOffset);
  return [lo, hi];
}

/** Whether both ends of the DOM range exactly equal the endpoints of the caret range [lo, hi) (O(1)). */
export function rangeMatchesInterval(
  range: Range,
  spans: readonly HTMLElement[],
  lo: number,
  hi: number,
): boolean {
  const first = spans[lo];
  const last = spans[hi - 1];
  if (!first || !last) return false;
  const [startNode, startOffset] = endpoint(first, false);
  const [endNode, endOffset] = endpoint(last, true);
  return (
    range.startContainer === startNode &&
    range.startOffset === startOffset &&
    range.endContainer === endNode &&
    range.endOffset === endOffset
  );
}

/**
 * Converts the characters overlapping a DOM range to a caret range [from, to). A character whose end (start) merely touches the range boundary
 * is treated as not overlapping. null if no character overlaps.
 */
export function rangeToCaretInterval(
  range: Range,
  spans: readonly HTMLElement[],
  /** The range this layer made last time. If the range is exactly the same, it is used as is without scanning characters. */
  hint?: readonly [number, number] | null,
): [number, number] | null {
  if (hint && rangeMatchesInterval(range, spans, hint[0], hint[1])) return [hint[0], hint[1]];
  let lo = -1;
  let hi = -1;
  for (let k = 0; k < spans.length; k++) {
    const span = spans[k]!;
    if (!range.intersectsNode(span)) continue;
    const text = span.firstChild;
    const textLength = text && text.nodeType === Node.TEXT_NODE ? (text as Text).length : 0;
    const startsAtEnd =
      (range.startContainer === text && range.startOffset >= textLength) ||
      (range.startContainer === span && range.startOffset >= span.childNodes.length);
    const endsAtStart =
      (range.endContainer === text && range.endOffset === 0) ||
      (range.endContainer === span && range.endOffset === 0);
    if (startsAtEnd || endsAtStart) continue;
    if (lo < 0) lo = k;
    hi = k;
  }
  return lo < 0 ? null : [lo, hi + 1];
}
