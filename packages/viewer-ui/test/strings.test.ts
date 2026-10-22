import { describe, expect, it } from 'vitest';
import { findLabel, initialFindState } from '../src/search-nav.js';
import { resolveUiLang, VIEWER_STRINGS, type ViewerStrings } from '../src/strings.js';

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;

/** 문자열 표의 값을 모두 글자로 펼친다(함수는 인수 1 로 부른다). */
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

describe('UI 언어 판정(사용자 요청 2026-10-23)', () => {
  it('주 언어가 ko 이면 한국어, 그 밖은 영어', () => {
    expect(resolveUiLang('ko')).toBe('ko');
    expect(resolveUiLang('ko-KR')).toBe('ko');
    expect(resolveUiLang('KO_kr')).toBe('ko');
    expect(resolveUiLang('en-US')).toBe('en');
    expect(resolveUiLang('en')).toBe('en');
    expect(resolveUiLang('ja')).toBe('en');
    expect(resolveUiLang('zh-CN')).toBe('en');
    expect(resolveUiLang('kok')).toBe('en'); // 콘칸어: 앞 두 글자만 같다
  });

  it('비어 있지 않은 첫 태그를 본다(없으면 영어)', () => {
    expect(resolveUiLang(null, 'ko-KR')).toBe('ko');
    expect(resolveUiLang('', 'ko')).toBe('ko');
    expect(resolveUiLang('en-US', 'ko-KR')).toBe('en');
    expect(resolveUiLang('ko', 'en-US')).toBe('ko');
    expect(resolveUiLang(undefined, null)).toBe('en');
    expect(resolveUiLang()).toBe('en');
  });
});

describe('뷰어 문자열 표', () => {
  it('한국어·영어 키가 같다', () => {
    expect(keysOf(VIEWER_STRINGS.en)).toEqual(keysOf(VIEWER_STRINGS.ko));
    expect(VIEWER_STRINGS.ko.lang).toBe('ko');
    expect(VIEWER_STRINGS.en.lang).toBe('en');
  });

  it('영어 표에는 한글이 없고 빈 문자열이 없다', () => {
    for (const s of texts(VIEWER_STRINGS.en)) {
      expect(s).not.toMatch(HANGUL);
      expect(s.trim()).not.toBe('');
    }
    for (const s of texts(VIEWER_STRINGS.ko)) expect(s.trim()).not.toBe('');
  });

  it('검색 라벨은 표를 따른다(기본 한국어)', () => {
    const none = { ...initialFindState(), status: 'done' as const };
    expect(findLabel(none)).toBe('결과 없음');
    expect(findLabel(none, VIEWER_STRINGS.en)).toBe('No results');
    expect(findLabel({ ...none, status: 'searching' }, VIEWER_STRINGS.en)).toBe('Searching…');
  });
});
