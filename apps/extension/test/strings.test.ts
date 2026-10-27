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

/** Expands every table value into text (functions are called with argument 1). The viewer-ui table is covered by the viewer-ui tests. */
function texts(t: AppStrings): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'function') out.push(String(v(...Array<number>(v.length).fill(1))));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
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
  // core text is Korean (pdf-ops save-method.ts).
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

describe('language decision (user request 2026-10-23)', () => {
  it('looks at the browser UI language first, otherwise navigator.language', () => {
    expect(detectLang({ uiLanguage: 'ko', navigatorLanguage: 'en-US' })).toBe('ko');
    expect(detectLang({ uiLanguage: 'ko-KR', navigatorLanguage: null })).toBe('ko');
    expect(detectLang({ uiLanguage: 'en-US', navigatorLanguage: 'ko-KR' })).toBe('en');
    expect(detectLang({ uiLanguage: 'ja', navigatorLanguage: 'ja-JP' })).toBe('en');
    expect(detectLang({ uiLanguage: null, navigatorLanguage: 'ko-KR' })).toBe('ko');
    expect(detectLang({ uiLanguage: null, navigatorLanguage: 'de-DE' })).toBe('en');
    expect(detectLang({ uiLanguage: null, navigatorLanguage: null })).toBe('en');
  });
});

describe('extension string table', () => {
  it('Korean and English keys are the same, and each points to the viewer-ui table of the same language', () => {
    expect(Object.keys(EN).sort()).toEqual(Object.keys(APP_STRINGS.ko).sort());
    expect(Object.keys(EN.saveErrors).sort()).toEqual(
      Object.keys(APP_STRINGS.ko.saveErrors).sort(),
    );
    expect(Object.keys(EN.saveWarnings).sort()).toEqual(
      Object.keys(APP_STRINGS.ko.saveWarnings).sort(),
    );
    expect(APP_STRINGS.ko.viewer.lang).toBe('ko');
    expect(EN.viewer.lang).toBe('en');
    expect(EN.saveFailedLines).toHaveLength(APP_STRINGS.ko.saveFailedLines.length);
  });

  it('the English table has no Hangul and no empty strings', () => {
    for (const s of texts(EN)) {
      expect(s).not.toMatch(HANGUL);
      expect(s.trim()).not.toBe('');
    }
    for (const s of texts(APP_STRINGS.ko)) expect(s.trim()).not.toBe('');
  });

  it('notice row text follows the table', () => {
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

  it('English pre-save check builds text from figures instead of the core Korean text', () => {
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
    // Korean uses the core text as is (same as before).
    expect(decideSave(plan({ heap: heap('warn') })).warnings).toEqual([heap('warn').message]);
  });

  it('core save warning: Korean uses the core sentence, English uses the cause code (a generic sentence if there is no code)', () => {
    const core = ['편집 엔진 오류(x) 상태에서 저장합니다.', '마지막 편집이 빠졌을 수 있습니다.'];
    const failed = plan({ warnings: core, warningCodes: ['edit-engine-failed'] });
    expect(decideSave(failed).warnings).toEqual(core);
    expect(decideSave(failed, null, EN).warnings).toEqual(EN.saveWarnings['edit-engine-failed']);
    expect(decideSave(plan({ warnings: core }), null, EN).warnings).toEqual([
      EN.saveWarningUnknown,
    ]);
    expect(decideSave(plan({ warnings: [] }), null, EN).warnings).toEqual([]);
  });

  it('status line error detail: Korean uses String(e), English uses the error name and known shape', () => {
    const e = new Error('PDF 요청 실패: HTTP 404');
    e.name = 'PdfRequestError';
    expect(APP_STRINGS.ko.errorText(e)).toBe('PdfRequestError: PDF 요청 실패: HTTP 404');
    expect(EN.errorText(e)).toBe('PDF request failed: HTTP 404');
    expect(EN.errorText('NotAllowedError: The request is not allowed')).toBe(
      'NotAllowedError: The request is not allowed',
    );
    expect(EN.errorText(new Error('초안 상태 이상'))).toBe('An internal error occurred.');
  });

  it('the About dialog also follows the table', () => {
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

describe('diagnostics display toggle (user request 2026-10-23)', () => {
  const key = (extra: Partial<ShortcutKeyLike> = {}): ShortcutKeyLike => ({
    code: 'KeyD',
    ctrlKey: true,
    altKey: true,
    shiftKey: true,
    metaKey: false,
    ...extra,
  });

  it('turns on when the address has a diag parameter', () => {
    expect(diagRequested('?diag')).toBe(true);
    expect(diagRequested('?file=http%3A%2F%2Fx%2Fa.pdf&diag')).toBe(true);
    expect(diagRequested('?e2e&diag=1')).toBe(true);
    expect(diagRequested('')).toBe(false);
    expect(diagRequested('?e2e')).toBe(false);
    expect(diagRequested('?file=diag.pdf')).toBe(false);
  });

  it('the shortcut is Ctrl+Alt+Shift+D (physical key); during composition and other combinations it is not', () => {
    expect(isDiagShortcut(key())).toBe(true);
    expect(isDiagShortcut(key({ shiftKey: false }))).toBe(false);
    expect(isDiagShortcut(key({ altKey: false }))).toBe(false);
    expect(isDiagShortcut(key({ ctrlKey: false }))).toBe(false);
    expect(isDiagShortcut(key({ metaKey: true }))).toBe(false);
    expect(isDiagShortcut(key({ code: 'KeyS' }))).toBe(false);
    expect(isDiagShortcut(key({ isComposing: true }))).toBe(false);
  });
});
