/**
 * 클러스터 분할과 줄 나눔 분류(계약 5.4, 3절). 클러스터는 확장 자소(Intl.Segmenter grapheme)이고, 분류는 클러스터 첫
 * 코드 포인트로 정한다. 금칙 표는 docs/m3-reflow.md 에 같은 내용으로 고정한다.
 */

/**
 * 줄 머리 금지(이 글자 앞에서 줄을 나누지 않는다). 닫는 괄호·따옴표, 문장 부호, 단위 기호, 일본어 작은 가나·장음.
 */
export const KINSOKU_HEAD =
  '!%),.:;?]}' +
  '¢°·’”‰′″›»…‥℃' +
  '、。〉》」』】〕〗〙〛〟・ー々〻ゝゞヽヾ' +
  'ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ' +
  'ㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ' +
  '！％），．：；？］｝｡｣､･ｰﾞﾟ';

/** 줄 끝 금지(이 글자 뒤에서 줄을 나누지 않는다). 여는 괄호·따옴표. */
export const KINSOKU_TAIL = '([{‘“‹«（［｛｢「『〈《【〔〖〘〚〝';

/** 강제 줄바꿈. "\r\n" 은 한 클러스터다. */
const HARD_BREAKS = new Set(['\n', '\r', '\r\n', '\u000B', '\u000C', '\u0085', '\u2028', '\u2029']);

/** 공백(뒤에서 나눌 수 있고, 줄 끝이면 폭에서 뺀다). */
const SPACES = new Set([
  0x0009, 0x0020, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2008, 0x2009,
  0x200a, 0x205f, 0x3000,
]);

/** 앞뒤에서 나누지 않는다: 줄바꿈 없는 공백·하이픈, 단어 결합자, 곧은 따옴표(여닫음을 알 수 없음, UAX #14 QU). */
const GLUE = new Set([0x0022, 0x0027, 0x00a0, 0x2007, 0x2011, 0x202f, 0x2060, 0xfeff]);

/** 뒤에서 나눌 수 있는 하이픈·대시(계약 5.4 "하이픈·대시 뒤"). */
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
  /** 줄 머리 금지. */
  noBreakBefore: boolean;
  /** 줄 끝 금지. */
  noBreakAfter: boolean;
  /** CJK 표의문자류(한자·가나·CJK 기호·전각): 둘이 이웃하면 그 사이에서 나눌 수 있다. 한글은 아니다(어절 우선). */
  cjk: boolean;
  /** CJK 표의문자류 또는 한글: 공백 없는 justify 줄에서 이웃한 둘 사이에 간격을 나눌 수 있다. */
  wide: boolean;
  digit: boolean;
}

const classCache = new Map<string, CharClass>();

/** 클러스터 분류. 클러스터 첫 코드 포인트(강제 줄바꿈은 클러스터 전체)로 정한다. */
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
    // 반각 한글(U+FFA0–FFDC)은 RE_CJK 범위(U+FF00–FF9F) 밖이다.
    cjk: cls === 'AL' && RE_CJK.test(ch),
    wide: cls === 'AL' && (RE_CJK.test(ch) || RE_HANGUL.test(ch)),
    digit: RE_DIGIT.test(ch),
  };
}

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** text 의 [start, end) 를 확장 자소 클러스터로 나눈 [시작, 끝) 목록(text 기준 위치). */
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

/** 클러스터를 이루는 코드 포인트. */
export function codePoints(cluster: string): number[] {
  const out: number[] = [];
  for (const ch of cluster) out.push(ch.codePointAt(0) ?? 0);
  return out;
}

/** 기본 무시 문자(글리프가 없으면 쓰지 않고 넘어간다). UCD Default_Ignorable_Code_Point. */
export function isDefaultIgnorable(cp: number): boolean {
  return RE_IGNORABLE.test(String.fromCodePoint(cp));
}
const RE_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

/** 클러스터 열에서 i-1 과 i 사이 일반 줄 나눔 기회(강제 줄바꿈 제외). 계약 5.4 규칙, 순서가 의미를 가진다. */
export function normalBreakBefore(cls: readonly CharClass[], i: number): boolean {
  const a = cls[i - 1];
  const b = cls[i];
  if (a === undefined || b === undefined) return false;
  if (a.cls === 'BK') return true;
  // 공백·강제 줄바꿈은 앞 줄 끝에 붙는다.
  if (b.cls === 'SP' || b.cls === 'BK') return false;
  // 금칙: 줄 머리 금지, 여는 부호(뒤 공백 포함) 뒤 금지.
  if (b.noBreakBefore) return false;
  let p = i - 1;
  while (p >= 0 && cls[p]?.cls === 'SP') p--;
  if (p >= 0 && cls[p]?.noBreakAfter) return false;
  if (a.cls === 'SP' || a.cls === 'ZW') return true;
  if (a.cls === 'GL' || b.cls === 'GL') return false;
  if (a.cls === 'HY') {
    // 단어에 붙은 하이픈 뒤만(" -x" 의 하이픈은 다음 단어 것), 숫자 앞은 나누지 않는다("2026-10").
    const before = cls[i - 2];
    return before !== undefined && before.cls !== 'SP' && before.cls !== 'BK' && !b.digit;
  }
  return a.cjk && b.cjk;
}

/**
 * 비상 나눔(어절·단어가 줄 폭보다 길 때 음절·글자 단위) 위치로 알맞은지. 공백·강제 줄바꿈 앞은 절대 안 되고(호출자가
 * 거른다), 금칙·결합(GL)을 지키는 위치를 우선한다.
 */
export function preferredEmergencyBreakBefore(cls: readonly CharClass[], i: number): boolean {
  const a = cls[i - 1];
  const b = cls[i];
  if (a === undefined || b === undefined) return false;
  return !b.noBreakBefore && !a.noBreakAfter && a.cls !== 'GL' && b.cls !== 'GL';
}
