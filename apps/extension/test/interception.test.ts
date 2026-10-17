import { describe, expect, it } from 'vitest';
import {
  buildPdfFallbackRules,
  decideInterceptionMode,
  DNR_RULE_IDS,
  extractFileParam,
  parseChromeMajor,
} from '../src/interception.js';

const VIEWER = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/viewer.html';

describe('decideInterceptionMode', () => {
  it('chrome.mimeHandler 가 있으면 MIME handler 경로', () => {
    expect(decideInterceptionMode({ hasMimeHandlerApi: true, chromeMajor: 151 })).toBe(
      'mime-handler',
    );
  });
  it('API 가 없고 128 이상이면 DNR 폴백', () => {
    expect(decideInterceptionMode({ hasMimeHandlerApi: false, chromeMajor: 128 })).toBe(
      'dnr-fallback',
    );
    expect(decideInterceptionMode({ hasMimeHandlerApi: false, chromeMajor: 150 })).toBe(
      'dnr-fallback',
    );
  });
  it('128 미만·판별 불가는 미지원', () => {
    expect(decideInterceptionMode({ hasMimeHandlerApi: false, chromeMajor: 127 })).toBe(
      'unsupported',
    );
    expect(decideInterceptionMode({ hasMimeHandlerApi: false, chromeMajor: null })).toBe(
      'unsupported',
    );
  });
});

describe('parseChromeMajor', () => {
  it('Chrome/Chromium UA 에서 주 버전을 읽는다', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
    expect(parseChromeMajor(ua)).toBe(150);
    expect(parseChromeMajor('Mozilla/5.0 HeadlessChrome/151.0.7000.1 Safari/537.36')).toBe(151);
    expect(parseChromeMajor('Firefox/140.0')).toBeNull();
  });
});

describe('buildPdfFallbackRules', () => {
  const rules = buildPdfFallbackRules(VIEWER);

  it('http(s)·file 규칙 2개를 고정 ID 로 만든다', () => {
    expect(rules.map((r) => r.id)).toEqual([DNR_RULE_IDS.http, DNR_RULE_IDS.file]);
    for (const r of rules) {
      expect(r.action.type).toBe('redirect');
      expect(r.action.redirect?.regexSubstitution).toBe(`${VIEWER}?file=\\0`);
      expect(r.condition.resourceTypes).toEqual(['main_frame', 'sub_frame']);
    }
  });

  it('http 규칙은 GET + content-type PDF 응답만, attachment 는 제외', () => {
    const http = rules[0]!;
    expect(http.condition.requestMethods).toEqual(['get']);
    expect(http.condition.responseHeaders?.[0]?.values).toContain('application/pdf');
    expect(http.condition.excludedResponseHeaders?.[0]?.header).toBe('content-disposition');
  });

  it('regexFilter + \\0 치환 결과에서 원 URL 이 그대로 복원된다', () => {
    const original = 'https://example.com/a/b.pdf?x=1&file=2#page=3';
    const http = rules[0]!;
    const re = new RegExp(http.condition.regexFilter!);
    const redirected = original.replace(re, (m) => `${VIEWER}?file=${m}`);
    expect(extractFileParam(redirected)).toBe(original);
  });

  it('file 규칙은 .pdf 확장자를 대소문자 무관하게 잡는다', () => {
    const file = rules[1]!;
    const re = new RegExp(file.condition.regexFilter!, 'i');
    expect(re.test('file:///C:/Users/harry/Docs/Report.PDF')).toBe(true);
    expect(re.test('file:///C:/Users/harry/Docs/report.txt')).toBe(false);
    expect(file.condition.requestMethods).toBeUndefined();
  });
});

describe('extractFileParam', () => {
  it('파라미터가 없거나 스킴이 허용 목록 밖이면 null', () => {
    expect(extractFileParam(`${VIEWER}`)).toBeNull();
    expect(extractFileParam(`${VIEWER}?file=`)).toBeNull();
    expect(extractFileParam(`${VIEWER}?file=javascript:alert(1)`)).toBeNull();
  });
  it('퍼센트 인코딩된 URL 도 허용', () => {
    expect(extractFileParam(`${VIEWER}?file=${encodeURIComponent('file:///tmp/a b.pdf')}`)).toBe(
      'file:///tmp/a b.pdf',
    );
  });
});
