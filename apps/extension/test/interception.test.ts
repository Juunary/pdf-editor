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
  it('MIME handler path when chrome.mimeHandler exists', () => {
    expect(decideInterceptionMode({ hasMimeHandlerApi: true, chromeMajor: 151 })).toBe(
      'mime-handler',
    );
  });
  it('DNR fallback when the API is absent and the version is 128 or above', () => {
    expect(decideInterceptionMode({ hasMimeHandlerApi: false, chromeMajor: 128 })).toBe(
      'dnr-fallback',
    );
    expect(decideInterceptionMode({ hasMimeHandlerApi: false, chromeMajor: 150 })).toBe(
      'dnr-fallback',
    );
  });
  it('below 128 or undeterminable is unsupported', () => {
    expect(decideInterceptionMode({ hasMimeHandlerApi: false, chromeMajor: 127 })).toBe(
      'unsupported',
    );
    expect(decideInterceptionMode({ hasMimeHandlerApi: false, chromeMajor: null })).toBe(
      'unsupported',
    );
  });
});

describe('parseChromeMajor', () => {
  it('reads the major version from a Chrome/Chromium UA', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
    expect(parseChromeMajor(ua)).toBe(150);
    expect(parseChromeMajor('Mozilla/5.0 HeadlessChrome/151.0.7000.1 Safari/537.36')).toBe(151);
    expect(parseChromeMajor('Firefox/140.0')).toBeNull();
  });
});

describe('buildPdfFallbackRules', () => {
  const rules = buildPdfFallbackRules(VIEWER);

  it('builds the two http(s) and file rules with fixed IDs', () => {
    expect(rules.map((r) => r.id)).toEqual([DNR_RULE_IDS.http, DNR_RULE_IDS.file]);
    for (const r of rules) {
      expect(r.action.type).toBe('redirect');
      expect(r.action.redirect?.regexSubstitution).toBe(`${VIEWER}?file=\\0`);
      expect(r.condition.resourceTypes).toEqual(['main_frame', 'sub_frame', 'object']);
    }
  });

  it('the http rule matches only GET + content-type PDF responses, excluding attachment', () => {
    const http = rules[0]!;
    expect(http.condition.requestMethods).toEqual(['get']);
    expect(http.condition.responseHeaders?.[0]?.values).toContain('application/pdf');
    expect(http.condition.excludedResponseHeaders?.[0]?.header).toBe('content-disposition');
  });

  it('the original URL is restored exactly from the regexFilter + \\0 substitution result', () => {
    const original = 'https://example.com/a/b.pdf?x=1&file=2#page=3';
    const http = rules[0]!;
    const re = new RegExp(http.condition.regexFilter!);
    const redirected = original.replace(re, (m) => `${VIEWER}?file=${m}`);
    expect(extractFileParam(redirected)).toBe(original);
  });

  it('the file rule matches the .pdf extension case-insensitively', () => {
    const file = rules[1]!;
    const re = new RegExp(file.condition.regexFilter!, 'i');
    expect(re.test('file:///C:/Users/harry/Docs/Report.PDF')).toBe(true);
    expect(re.test('file:///C:/Users/harry/Docs/report.txt')).toBe(false);
    expect(file.condition.requestMethods).toBeUndefined();
  });
});

describe('extractFileParam', () => {
  it('null when the parameter is missing or the scheme is outside the allow list', () => {
    expect(extractFileParam(`${VIEWER}`)).toBeNull();
    expect(extractFileParam(`${VIEWER}?file=`)).toBeNull();
    expect(extractFileParam(`${VIEWER}?file=javascript:alert(1)`)).toBeNull();
  });
  it('percent-encoded URLs are also accepted', () => {
    expect(extractFileParam(`${VIEWER}?file=${encodeURIComponent('file:///tmp/a b.pdf')}`)).toBe(
      'file:///tmp/a b.pdf',
    );
  });
});
