import { describe, expect, it } from 'vitest';
import type { SaveHeapEstimate, SavePlan } from '@pdf-editor/shared-types';
import { aboutContent } from '../src/viewer/about.js';
import { diagRequested, isDiagShortcut, type ShortcutKeyLike } from '../src/viewer/diag.js';
import {
  journalNotice,
  recoveredNotice,
  redactNotice,
  sizeLimitNotice,
  supportedSizeNotice,
} from '../src/viewer/notices.js';
import { decideSave } from '../src/viewer/save-plan.js';
import { APP_STRINGS, detectLang, type AppStrings } from '../src/viewer/strings.js';

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;
const MIB = 2 ** 20;
const EN = APP_STRINGS.en;

/** 표의 값을 모두 글자로 펼친다(함수는 인수 1 로 부른다). viewer-ui 표는 viewer-ui 시험이 본다. */
function texts(t: AppStrings): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'function') out.push(String(v(...Array<number>(v.length).fill(1))));
    else if (Array.isArray(v)) v.forEach(walk);
  };
  for (const [k, v] of Object.entries(t)) if (k !== 'viewer') walk(v);
  return out;
}

const heap = (
  level: SaveHeapEstimate['level'],
  extra: Partial<SaveHeapEstimate> = {},
): SaveHeapEstimate => ({
  inputBytes: 100 * MIB,
  ratio: 8,
  estimatedPeakBytes: 1600 * MIB,
  limitBytes: 2048 * MIB,
  fraction: 0.78,
  level,
  // core 문구는 한국어다(pdf-ops save-method.ts).
  message: '예상 피크 WASM 힙 1600 MiB 가 상한 2048 MiB 의 78% 입니다.',
  ...extra,
});

const plan = (extra: Partial<SavePlan> = {}): SavePlan => ({
  method: 'full',
  options: 'garbage=yes,compress,objstms',
  reason: 'test',
  canBeSavedIncrementally: false,
  heap: heap('ok'),
  edits: null,
  ...extra,
});

describe('언어 판정(사용자 요청 2026-10-23)', () => {
  it('브라우저 UI 언어를 먼저 보고, 없으면 navigator.language', () => {
    expect(detectLang({ uiLanguage: 'ko', navigatorLanguage: 'en-US' })).toBe('ko');
    expect(detectLang({ uiLanguage: 'ko-KR', navigatorLanguage: null })).toBe('ko');
    expect(detectLang({ uiLanguage: 'en-US', navigatorLanguage: 'ko-KR' })).toBe('en');
    expect(detectLang({ uiLanguage: 'ja', navigatorLanguage: 'ja-JP' })).toBe('en');
    expect(detectLang({ uiLanguage: null, navigatorLanguage: 'ko-KR' })).toBe('ko');
    expect(detectLang({ uiLanguage: null, navigatorLanguage: 'de-DE' })).toBe('en');
    expect(detectLang({ uiLanguage: null, navigatorLanguage: null })).toBe('en');
  });
});

describe('확장 문자열 표', () => {
  it('한국어·영어 키가 같고 각자 같은 언어의 viewer-ui 표를 가리킨다', () => {
    expect(Object.keys(EN).sort()).toEqual(Object.keys(APP_STRINGS.ko).sort());
    expect(APP_STRINGS.ko.viewer.lang).toBe('ko');
    expect(EN.viewer.lang).toBe('en');
    expect(EN.saveFailedLines).toHaveLength(APP_STRINGS.ko.saveFailedLines.length);
  });

  it('영어 표에는 한글이 없고 빈 문자열이 없다', () => {
    for (const s of texts(EN)) {
      expect(s).not.toMatch(HANGUL);
      expect(s.trim()).not.toBe('');
    }
    for (const s of texts(APP_STRINGS.ko)) expect(s.trim()).not.toBe('');
  });

  it('알림 줄 문구는 표를 따른다', () => {
    expect(redactNotice({ total: 2, pages: [0, 3] }, EN)).toContain('2 unapplied Redact');
    expect(redactNotice({ total: 2, pages: [0, 3] }, EN)).toContain('page 1, 4');
    expect(sizeLimitNotice(heap('over-limit'), EN)).toBe(
      'This document exceeds the supported size (estimated save peak 1600 MiB / limit 2048 MiB). You can view it, but it cannot be saved after editing.',
    );
    expect(supportedSizeNotice(900 * MIB, 790 * MIB, EN)).toContain('supported size of 790 MiB');
    const advice = {
      advised: true,
      journalBytes: 1600 * MIB,
      incrementBytes: 0,
      thresholdBytes: 1536 * MIB,
    };
    expect(journalNotice(advice, EN)).toBe(
      `${EN.journalReopenAdvice} (edit history about 1600 MiB, warning level 1536 MiB)`,
    );
    expect(recoveredNotice(1, true, EN)).toContain('1 edit(s) re-applied from the last save');
  });

  it('영어 저장 전 판정은 core 한국어 문구 대신 수치로 문구를 만든다', () => {
    const warn = decideSave(plan({ heap: heap('warn') }), null, EN);
    expect(warn.warnings).toEqual([EN.heapWarn('1600 MiB', '2048 MiB')]);
    const blocked = decideSave(plan({ heap: heap('over-limit') }), null, EN);
    expect(blocked.block).toBe(
      `${EN.heapOverLimit('2048 MiB', '1600 MiB')} ${EN.blockedSaveOptions}`,
    );
    const retry = decideSave(
      plan({ heap: heap('over-limit', { grownHeapBasis: true }) }),
      null,
      EN,
    );
    expect(retry.confirmLabel).toBe('Try saving anyway');
    const edits = decideSave(
      plan({ edits: { pages: [0, 2], structureUnlinked: 1, pdfaDeclared: true } }),
      null,
      EN,
    );
    expect(edits.warnings).toEqual([EN.structureUnlinked(1), EN.pdfaDeclared]);
    expect(edits.infos).toEqual([EN.editPagesRecorded('1, 3')]);
    for (const s of [...warn.warnings, blocked.block!, ...edits.warnings, ...edits.infos]) {
      expect(s).not.toMatch(HANGUL);
    }
    // 한국어는 core 문구를 그대로 쓴다(이전과 같음).
    expect(decideSave(plan({ heap: heap('warn') })).warnings).toEqual([heap('warn').message]);
  });

  it('정보 대화상자도 표를 따른다', () => {
    const c = aboutContent(
      {
        version: '1.0.0',
        sourceUrl: 'https://x',
        noticesUrl: 'chrome-extension://x/N',
        heap: null,
      },
      EN,
    );
    expect(c.title).toBe('About PDF Editor');
    expect(c.lines[0]).toBe('Version 1.0.0');
    expect(c.links.map((l) => l.label)).toEqual([
      'Source code (v1.0.0)',
      'Third-party license notices',
    ]);
    for (const s of [c.title, ...c.lines, ...c.links.map((l) => l.label)]) {
      expect(s).not.toMatch(HANGUL);
    }
  });
});

describe('진단 표시 켜기(사용자 요청 2026-10-23)', () => {
  const key = (extra: Partial<ShortcutKeyLike> = {}): ShortcutKeyLike => ({
    code: 'KeyD',
    ctrlKey: true,
    altKey: true,
    shiftKey: true,
    metaKey: false,
    ...extra,
  });

  it('주소에 diag 매개변수가 있으면 켠다', () => {
    expect(diagRequested('?diag')).toBe(true);
    expect(diagRequested('?file=http%3A%2F%2Fx%2Fa.pdf&diag')).toBe(true);
    expect(diagRequested('?e2e&diag=1')).toBe(true);
    expect(diagRequested('')).toBe(false);
    expect(diagRequested('?e2e')).toBe(false);
    expect(diagRequested('?file=diag.pdf')).toBe(false);
  });

  it('단축키는 Ctrl+Alt+Shift+D(물리 키), 조합 중·다른 조합은 아니다', () => {
    expect(isDiagShortcut(key())).toBe(true);
    expect(isDiagShortcut(key({ shiftKey: false }))).toBe(false);
    expect(isDiagShortcut(key({ altKey: false }))).toBe(false);
    expect(isDiagShortcut(key({ ctrlKey: false }))).toBe(false);
    expect(isDiagShortcut(key({ metaKey: true }))).toBe(false);
    expect(isDiagShortcut(key({ code: 'KeyS' }))).toBe(false);
    expect(isDiagShortcut(key({ isComposing: true }))).toBe(false);
  });
});
