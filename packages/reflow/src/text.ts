/**
 * Cluster splitting and line-break classification (contract 5.4, section 3). A cluster is an extended grapheme cluster (Intl.Segmenter grapheme), and classification is decided by the cluster's first
 * code point. The kinsoku table is fixed with the same content in docs/m3-reflow.md.
 */

/**
 * Line-start prohibited (no line break before these characters). Closing brackets and quotes, sentence punctuation, unit symbols, Japanese small kana and the long vowel mark.
 */
export const KINSOKU_HEAD =
  '!%),.:;?]}' +
  '¢°·’”‰′″›»…‥℃' +
  '、。〉》」』】〕〗〙〛〟・ー々〻ゝゞヽヾ' +
  'ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ' +
  'ㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ' +
  '！％），．：；？］｝｡｣､･ｰﾞﾟ';

/** Line-end prohibited (no line break after these characters). Opening brackets and quotes. */
export const KINSOKU_TAIL = '([{‘“‹«（［｛｢「『〈《【〔〖〘〚〝';

/** Forced line break. "\r\n" is one cluster. */
const HARD_BREAKS = new Set(['\n', '\r', '\r\n', '\u000B', '\u000C', '\u0085', '\u2028', '\u2029']);

/** Whitespace (a break is allowed after it, and at the line end it is subtracted from the width). */
const SPACES = new Set([
  0x0009, 0x0020, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2008, 0x2009,
  0x200a, 0x205f, 0x3000,
]);

/** No break before or after: non-breaking space/hyphen, word joiner, straight quotes (open/close cannot be told apart, UAX #14 QU). */
const GLUE = new Set([0x0022, 0x0027, 0x00a0, 0x2007, 0x2011, 0x202f, 0x2060, 0xfeff]);

/** Hyphen/dash after which a break is allowed (contract 5.4 "after hyphen/dash"). */
const HYPHENS = new Set([0x002d, 0x00ad, 0x2010, 0x2012, 0x2013, 0x2014, 0x2015, 0x2e3a, 0x2e3b]);

const ZERO_WIDTH_SPACE = 0x200b;

const HEAD_SET = new Set([...KINSOKU_HEAD].map((c) => c.codePointAt(0) ?? 0));
const TAIL_SET = new Set([...KINSOKU_TAIL].map((c) => c.codePointAt(0) ?? 0));

const RE_CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\u3000-\u303f\u31f0-\u31ff\u3200-\u33ff\ufe30-\ufe4f\uff00-\uff9f\uffe0-\uffef\p{Extended_Pictographic}]/u;
const RE_DIGIT = /\p{Nd}/u;
const RE_HANGUL = /\p{Script=Hangul}/u;

export type BreakClass = 'BK' | 'SP' | 'ZW' | 'GL' | 'HY' | 'AL';

export interface CharClass {
  cls: BreakClass;
  /** Line-start prohibited. */
  noBreakBefore: boolean;
  /** Line-end prohibited. */
  noBreakAfter: boolean;
  /** CJK ideograph-like (Hanja, kana, CJK symbols, full-width): a break is allowed between two neighbors. Not Hangul (word units take priority). */
  cjk: boolean;
  /** CJK ideograph-like or Hangul: in a justify line without whitespace, spacing can be distributed between two neighbors. */
  wide: boolean;
  digit: boolean;
}

const classCache = new Map<string, CharClass>();

/** Cluster classification. Decided by the cluster's first code point (the whole cluster for a forced line break). */
export function classifyCluster(cluster: string): CharClass {
  if (HARD_BREAKS.has(cluster)) return BK_CLASS;
  const cp = cluster.codePointAt(0) ?? 0;
  const key = String.fromCodePoint(cp);
  let c = classCache.get(key);
  if (c === undefined) {
    c = classifyCodePoint(cp, key);
    classCache.set(key, c);
  }
  return c;
}

const BK_CLASS: CharClass = {
  cls: 'BK',
  noBreakBefore: false,
  noBreakAfter: false,
  cjk: false,
  wide: false,
  digit: false,
};

function classifyCodePoint(cp: number, ch: string): CharClass {
  let cls: BreakClass = 'AL';
  if (HARD_BREAKS.has(ch)) cls = 'BK';
  else if (SPACES.has(cp)) cls = 'SP';
  else if (cp === ZERO_WIDTH_SPACE) cls = 'ZW';
  else if (GLUE.has(cp)) cls = 'GL';
  else if (HYPHENS.has(cp)) cls = 'HY';
  return {
    cls,
    noBreakBefore: HEAD_SET.has(cp),
    noBreakAfter: TAIL_SET.has(cp),
    // Half-width Hangul (U+FFA0–FFDC) is outside the RE_CJK range (U+FF00–FF9F).
    cjk: cls === 'AL' && RE_CJK.test(ch),
    wide: cls === 'AL' && (RE_CJK.test(ch) || RE_HANGUL.test(ch)),
    digit: RE_DIGIT.test(ch),
  };
}

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** List of [start, end) extended grapheme clusters of text's [start, end) (positions relative to text). */
export function graphemeRanges(text: string, start: number, end: number): [number, number][] {
  const out: [number, number][] = [];
  if (end <= start) return out;
  const part = text.slice(start, end);
  let prev = 0;
  for (const s of graphemes.segment(part)) {
    if (s.index > prev) out.push([start + prev, start + s.index]);
    prev = s.index;
  }
  out.push([start + prev, end]);
  return out;
}

/** Code points that make up a cluster. */
export function codePoints(cluster: string): number[] {
  const out: number[] = [];
  for (const ch of cluster) out.push(ch.codePointAt(0) ?? 0);
  return out;
}

/** Default-ignorable characters (skipped without writing if there is no glyph). UCD Default_Ignorable_Code_Point. */
export function isDefaultIgnorable(cp: number): boolean {
  return RE_IGNORABLE.test(String.fromCodePoint(cp));
}
const RE_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

/** Ordinary line-break opportunity between i-1 and i in the cluster sequence (excluding forced line breaks). Contract 5.4 rules; order is significant. */
export function normalBreakBefore(cls: readonly CharClass[], i: number): boolean {
  const a = cls[i - 1];
  const b = cls[i];
  if (a === undefined || b === undefined) return false;
  if (a.cls === 'BK') return true;
  // Whitespace and forced line breaks attach to the end of the preceding line.
  if (b.cls === 'SP' || b.cls === 'BK') return false;
  // Kinsoku: line-start prohibited, and no break after an opening mark (including trailing whitespace).
  if (b.noBreakBefore) return false;
  let p = i - 1;
  while (p >= 0 && cls[p]?.cls === 'SP') p--;
  if (p >= 0 && cls[p]?.noBreakAfter) return false;
  if (a.cls === 'SP' || a.cls === 'ZW') return true;
  if (a.cls === 'GL' || b.cls === 'GL') return false;
  if (a.cls === 'HY') {
    // Only after a hyphen attached to a word (the hyphen in " -x" belongs to the next word), and no break before a digit ("2026-10").
    const before = cls[i - 2];
    return before !== undefined && before.cls !== 'SP' && before.cls !== 'BK' && !b.digit;
  }
  return a.cjk && b.cjk;
}

/**
 * Whether this is a suitable position for an emergency break (per syllable/character when a word is longer than the line width). Never before whitespace or a forced line break (the caller
 * filters these out); positions that respect kinsoku and glue (GL) are preferred.
 */
export function preferredEmergencyBreakBefore(cls: readonly CharClass[], i: number): boolean {
  const a = cls[i - 1];
  const b = cls[i];
  if (a === undefined || b === undefined) return false;
  return !b.noBreakBefore && !a.noBreakAfter && a.cls !== 'GL' && b.cls !== 'GL';
}
