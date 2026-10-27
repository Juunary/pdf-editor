/**
 * Editor text helpers (pure functions). Positions are UTF-16 offsets and the caret sits only on extended grapheme cluster boundaries
 * (docs/m3-contract.md section 3).
 */

const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
const wordSegmenter = new Intl.Segmenter('und', { granularity: 'word' });

/**
 * Input/paste text cleanup: line breaks become `\n`, tabs and U+00A0 (NBSP) become spaces, other control characters are removed, NFC normalization (for NFD jamo input,
 * contract 1.3·5.9 fix 2: the fallback font cmap has no U+00A0, so it is replaced with a space).
 * Only the forced line break `\n` is kept as a control character.
 */
export function normalizeInput(raw: string): string {
  let out = '';
  const text = raw.replace(/\r\n?|\u2028|\u2029/g, '\n');
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === '\n') out += ch;
    else if (ch === '\t' || ch === '\u00a0') out += ' ';
    else if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) continue;
    else out += ch;
  }
  return out.normalize('NFC');
}

let boundaryCache: { text: string; bounds: number[] } | null = null;

/** Grapheme boundary positions (including 0 and text.length, ascending). */
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

/** Nearest boundary at or below pos. */
export function snapBoundary(text: string, pos: number): number {
  const bounds = graphemeBoundaries(text);
  let best = 0;
  for (const b of bounds) {
    if (b > pos) break;
    best = b;
  }
  return best;
}

/** Nearest boundary smaller than pos (0 if none). */
export function prevBoundary(text: string, pos: number): number {
  const bounds = graphemeBoundaries(text);
  let best = 0;
  for (const b of bounds) {
    if (b >= pos) break;
    best = b;
  }
  return best;
}

/** Nearest boundary larger than pos (text.length if none). */
export function nextBoundary(text: string, pos: number): number {
  for (const b of graphemeBoundaries(text)) if (b > pos) return b;
  return text.length;
}

/** Nearest boundary at or above pos. */
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

/** Ctrl+← : start of the previous word (skips whitespace and punctuation). */
export function prevWordStart(text: string, pos: number): number {
  const segs = wordSegments(text);
  let target = 0;
  for (const s of segs) {
    if (s.start >= pos) break;
    if (s.wordLike) target = s.start;
  }
  return target;
}

/** Ctrl+→ : start of the next word (the end if none). */
export function nextWordStart(text: string, pos: number): number {
  for (const s of wordSegments(text)) {
    if (s.wordLike && s.start > pos) return s.start;
  }
  return text.length;
}

/** Range of the word (or run of whitespace/punctuation) containing pos. Used for double-click selection. */
export function wordRangeAt(text: string, pos: number): [number, number] {
  if (text.length === 0) return [0, 0];
  const at = Math.min(pos, text.length - 1);
  for (const s of wordSegments(text)) {
    if (at >= s.start && at < s.end) return [s.start, s.end];
  }
  return [at, at];
}

/** Characters that close an undo unit after input (whitespace, sentence punctuation, contract 1.3 I6). */
export function endsUndoUnit(inserted: string): boolean {
  if (inserted === '') return false;
  const last = [...inserted].at(-1) ?? '';
  return /^[\s\p{P}]$/u.test(last);
}
