/**
 * 편집기 텍스트 도우미(순수 함수). 위치는 UTF-16 위치이고 캐럿은 확장 자소(grapheme) 경계에만 놓인다
 * (docs/m3-contract.md 3절).
 */

const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
const wordSegmenter = new Intl.Segmenter('und', { granularity: 'word' });

/**
 * 입력·붙여넣기 텍스트 정리: 줄바꿈은 `\n`, 탭은 공백, 그 밖 제어 문자는 제거, NFC 정규화(NFD 자모 입력 대비, 계약 1.3).
 * 강제 줄바꿈 `\n` 만 제어 문자로 남긴다.
 */
export function normalizeInput(raw: string): string {
  let out = '';
  const text = raw.replace(/\r\n?|\u2028|\u2029/g, '\n');
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === '\n') out += ch;
    else if (ch === '\t') out += ' ';
    else if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) continue;
    else out += ch;
  }
  return out.normalize('NFC');
}

let boundaryCache: { text: string; bounds: number[] } | null = null;

/** 자소 경계 위치(0 과 text.length 포함, 오름차순). */
export function graphemeBoundaries(text: string): number[] {
  if (boundaryCache?.text === text) return boundaryCache.bounds;
  const bounds = [0];
  for (const seg of graphemeSegmenter.segment(text)) {
    const end = seg.index + seg.segment.length;
    if (end > (bounds[bounds.length - 1] ?? 0)) bounds.push(end);
  }
  boundaryCache = { text, bounds };
  return bounds;
}

/** pos 이하에서 가장 가까운 경계. */
export function snapBoundary(text: string, pos: number): number {
  const bounds = graphemeBoundaries(text);
  let best = 0;
  for (const b of bounds) {
    if (b > pos) break;
    best = b;
  }
  return best;
}

/** pos 보다 작은 가장 가까운 경계(없으면 0). */
export function prevBoundary(text: string, pos: number): number {
  const bounds = graphemeBoundaries(text);
  let best = 0;
  for (const b of bounds) {
    if (b >= pos) break;
    best = b;
  }
  return best;
}

/** pos 보다 큰 가장 가까운 경계(없으면 text.length). */
export function nextBoundary(text: string, pos: number): number {
  for (const b of graphemeBoundaries(text)) if (b > pos) return b;
  return text.length;
}

/** pos 이상에서 가장 가까운 경계. */
export function ceilBoundary(text: string, pos: number): number {
  for (const b of graphemeBoundaries(text)) if (b >= pos) return b;
  return text.length;
}

interface WordSeg {
  start: number;
  end: number;
  wordLike: boolean;
}

function wordSegments(text: string): WordSeg[] {
  const out: WordSeg[] = [];
  for (const seg of wordSegmenter.segment(text)) {
    out.push({
      start: seg.index,
      end: seg.index + seg.segment.length,
      wordLike: seg.isWordLike === true,
    });
  }
  return out;
}

/** Ctrl+← : 이전 단어 시작(공백·부호는 건너뛴다). */
export function prevWordStart(text: string, pos: number): number {
  const segs = wordSegments(text);
  let target = 0;
  for (const s of segs) {
    if (s.start >= pos) break;
    if (s.wordLike) target = s.start;
  }
  return target;
}

/** Ctrl+→ : 다음 단어 시작(없으면 끝). */
export function nextWordStart(text: string, pos: number): number {
  for (const s of wordSegments(text)) {
    if (s.wordLike && s.start > pos) return s.start;
  }
  return text.length;
}

/** pos 가 놓인 단어(또는 공백·부호 덩어리) 구간. 더블클릭 선택용. */
export function wordRangeAt(text: string, pos: number): [number, number] {
  if (text.length === 0) return [0, 0];
  const at = Math.min(pos, text.length - 1);
  for (const s of wordSegments(text)) {
    if (at >= s.start && at < s.end) return [s.start, s.end];
  }
  return [at, at];
}

/** 입력 뒤 되돌리기 단위를 닫는 글자(공백·문장부호, 계약 1.3 I6). */
export function endsUndoUnit(inserted: string): boolean {
  if (inserted === '') return false;
  const last = [...inserted].at(-1) ?? '';
  return /^[\s\p{P}]$/u.test(last);
}
