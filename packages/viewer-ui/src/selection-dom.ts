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

/** 캐럿 구간 [from, to) 를 DOM 선택으로 만든다. 빈 구간이면 선택을 지운다. */
export function selectInterval(
  selection: Selection,
  spans: readonly HTMLElement[],
  from: number,
  to: number,
): void {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(spans.length, Math.max(from, to));
  if (lo >= hi) {
    selection.removeAllRanges();
    return;
  }
  const [startNode, startOffset] = endpoint(spans[lo]!, false);
  const [endNode, endOffset] = endpoint(spans[hi - 1]!, true);
  selection.setBaseAndExtent(startNode, startOffset, endNode, endOffset);
}

/**
 * DOM 범위와 겹치는 글자를 캐럿 구간 [from, to) 로 바꾼다. 범위 경계가 글자의 끝(시작)에 걸친 글자는
 * 겹치지 않은 것으로 본다. 겹치는 글자가 없으면 null.
 */
export function rangeToCaretInterval(
  range: Range,
  spans: readonly HTMLElement[],
): [number, number] | null {
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
