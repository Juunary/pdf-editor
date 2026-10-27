import { describe, expect, it } from 'vitest';
import { findLabel, initialFindState } from '../src/search-nav.js';
import { resolveUiLang, VIEWER_STRINGS, type ViewerStrings } from '../src/strings.js';

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;

/** Expands every value of the string table into characters (functions are called with argument 1). */
function texts(t: ViewerStrings): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'function') out.push(String(v(...Array<number>(v.length).fill(1))));
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(t);
  return out;
}

const keysOf = (o: object): string[] =>
  Object.entries(o)
    .flatMap(([k, v]) => (v && typeof v === 'object' ? keysOf(v).map((sub) => `${k}.${sub}`) : [k]))
    .sort();

describe('UI language detection (user request 2026-10-23)', () => {
  it('Korean if the primary language is ko, English otherwise', () => {
    expect(resolveUiLang('ko')).toBe('ko');
    expect(resolveUiLang('ko-KR')).toBe('ko');
    expect(resolveUiLang('KO_kr')).toBe('ko');
    expect(resolveUiLang('en-US')).toBe('en');
    expect(resolveUiLang('en')).toBe('en');
    expect(resolveUiLang('ja')).toBe('en');
    expect(resolveUiLang('zh-CN')).toBe('en');
    expect(resolveUiLang('kok')).toBe('en'); // Konkani: only the first two letters match
  });

  it('uses the first non-empty tag (English if none)', () => {
    expect(resolveUiLang(null, 'ko-KR')).toBe('ko');
    expect(resolveUiLang('', 'ko')).toBe('ko');
    expect(resolveUiLang('en-US', 'ko-KR')).toBe('en');
    expect(resolveUiLang('ko', 'en-US')).toBe('ko');
    expect(resolveUiLang(undefined, null)).toBe('en');
    expect(resolveUiLang()).toBe('en');
  });
});

describe('viewer string table', () => {
  it('the Korean and English keys are the same', () => {
    expect(keysOf(VIEWER_STRINGS.en)).toEqual(keysOf(VIEWER_STRINGS.ko));
    expect(VIEWER_STRINGS.ko.lang).toBe('ko');
    expect(VIEWER_STRINGS.en.lang).toBe('en');
  });

  it('the English table has no Hangul and no empty strings', () => {
    for (const s of texts(VIEWER_STRINGS.en)) {
      expect(s).not.toMatch(HANGUL);
      expect(s.trim()).not.toBe('');
    }
    for (const s of texts(VIEWER_STRINGS.ko)) expect(s.trim()).not.toBe('');
  });

  it('the search label follows the table (Korean by default)', () => {
    const none = { ...initialFindState(), status: 'done' as const };
    expect(findLabel(none)).toBe('결과 없음');
    expect(findLabel(none, VIEWER_STRINGS.en)).toBe('No results');
    expect(findLabel({ ...none, status: 'searching' }, VIEWER_STRINGS.en)).toBe('Searching…');
  });
});
