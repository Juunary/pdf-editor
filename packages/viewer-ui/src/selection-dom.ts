/**
 * DOM Selection 과 읽기 순서 캐럿 구간 사이의 연결. 텍스트 층의 글자 span 은 DOM 순서가 읽기 순서이고,
 * `spans[k]` 가 ReadingOrder.items[k] 에 대응한다.
 */

/** span 안 글자 텍스트 노드와 경계 오프셋. */
function endpoint(span: HTMLElement, atEnd: boolean): [Node, number] {
  const text = span.firstChild;
  if (!text) return [span, 0];
  return [text, atEnd && text.nodeType === Node.TEXT_NODE ? (text as Text).length : 0];
}

/**
 * 캐럿 구간 [from, to) 를 DOM 선택으로 만들고, 실제로 만든 구간(범위 보정 후)을 돌려준다.
 * 빈 구간이면 선택을 지우고 null.
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

/** DOM 범위의 양 끝이 캐럿 구간 [lo, hi) 의 끝점과 정확히 같은지(O(1)). */
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
 * DOM 범위와 겹치는 글자를 캐럿 구간 [from, to) 로 바꾼다. 범위 경계가 글자의 끝(시작)에 걸친 글자는
 * 겹치지 않은 것으로 본다. 겹치는 글자가 없으면 null.
 */
export function rangeToCaretInterval(
  range: Range,
  spans: readonly HTMLElement[],
  /** 직전에 이 층이 만든 구간. 범위가 그 구간과 정확히 같으면 글자를 훑지 않고 그대로 쓴다. */
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
