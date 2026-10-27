import { describe, expect, it } from 'vitest';
import type { SaveHeapEstimate } from '@pdf-editor/shared-types';
import { aboutContent } from '../src/viewer/about.js';
import { SUPPORTED_INPUT_BYTES } from '@pdf-editor/core/client';
import type { JournalAdvice } from '@pdf-editor/shared-types';
import {
  HISTORY_AFTER_SAVE_NOTICE,
  journalNotice,
  sizeLimitNotice,
  supportedSizeNotice,
} from '../src/viewer/notices.js';
import { JOURNAL_REOPEN_ADVICE, decideSave } from '../src/viewer/save-plan.js';
import { sourceUrl } from '../scripts/manifest.mjs';

const MIB = 2 ** 20;
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
  message: null,
  ...extra,
});

describe('About dialog', () => {
  const base = { version: '1.0.0', sourceUrl: sourceUrl('1.0.0'), noticesUrl: null, heap: null };

  it('contains the version, license and version-tagged source link', () => {
    const c = aboutContent(base);
    expect(c.lines[0]).toBe('버전 1.0.0');
    expect(c.lines.join('\n')).toContain('AGPL-3.0-or-later');
    expect(c.links[0]).toEqual({
      label: '소스 코드 (v1.0.0)',
      href: 'https://github.com/Juunary/pdf-editor/tree/v1.0.0',
    });
  });

  it('shows the notices link only when a URL exists, and the document size line only when a check exists', () => {
    expect(aboutContent(base).links).toHaveLength(1);
    const c = aboutContent({
      ...base,
      noticesUrl: 'chrome-extension://x/THIRD_PARTY_NOTICES.txt',
      heap: heap('warn'),
    });
    expect(c.links.map((l) => l.label)).toContain('서드파티 라이선스 고지');
    expect(c.lines.at(-1)).toContain('1600 MiB / 한계 2048 MiB');
  });

  it('contains the supported size, edit history and undo-loss notices', () => {
    const text = aboutContent(base).lines.join('\n');
    expect(text).toContain('지원 문서 크기');
    expect(text).toContain('편집 기록');
    expect(text).toContain('되돌리기 기록이 사라집니다');
    expect(text).toContain('다시 실행 기록이 사라집니다');
  });
});

describe('supported size notice', () => {
  it('ok gives no notice; warn and over-limit report the figures and the outcome', () => {
    expect(sizeLimitNotice(heap('ok'))).toBeNull();
    expect(sizeLimitNotice(null)).toBeNull();
    expect(sizeLimitNotice(heap('warn'))).toContain('편집·저장이 실패할 수 있습니다');
    expect(sizeLimitNotice(heap('over-limit', { estimatedPeakBytes: 2500 * MIB }))).toContain(
      '저장할 수 없습니다',
    );
  });
});

describe('journal limit notice', () => {
  const plan = (h: SaveHeapEstimate) => ({
    method: 'full' as const,
    options: 'x',
    reason: 'x',
    canBeSavedIncrementally: false,
    heap: h,
    edits: null,
  });

  const advice = (advised: boolean, journalBytes = 1200 * MIB): JournalAdvice => ({
    advised,
    journalBytes,
    incrementBytes: 400 * MIB,
    thresholdBytes: 1536 * MIB,
  });

  it('when the core journal check is advised, recommends save and reopen if saving is possible, and the abort text gets only the edit history size appended (M2)', () => {
    expect(decideSave(plan(heap('warn')), advice(true)).infos).toContain(JOURNAL_REOPEN_ADVICE);
    const blocked = decideSave(plan(heap('over-limit')), advice(true)).block!;
    expect(blocked).not.toContain(JOURNAL_REOPEN_ADVICE);
    expect(blocked).toContain('편집 기록이 약 1200 MiB');
    expect(blocked).toContain('저장하지 않은 편집은 모두 사라집니다');
    expect(decideSave(plan(heap('ok')), advice(true)).infos).toContain(JOURNAL_REOPEN_ADVICE);
  });

  it('the heap check text and the journal recommendation do not append the same text twice (M2)', () => {
    const d = decideSave(
      plan(heap('warn', { message: '예상 피크 WASM 힙 1600 MiB' })),
      advice(true),
    );
    const all = [...d.warnings, ...d.infos].join(' ');
    expect(all.split('다시 열').length - 1).toBe(1);
  });

  it('does not append anything when not advised or when no check was received, regardless of heap level and journalBytes', () => {
    expect(
      decideSave(plan(heap('warn', { journalBytes: 300 * MIB })), advice(false)).infos,
    ).toEqual([]);
    expect(decideSave(plan(heap('warn', { journalBytes: 300 * MIB }))).infos).toEqual([]);
    expect(decideSave(plan(heap('over-limit')), null).block).not.toContain(JOURNAL_REOPEN_ADVICE);
  });

  it('post-commit notice text: shows the journal size and warning line only when advised', () => {
    expect(journalNotice(null)).toBeNull();
    expect(journalNotice(advice(false))).toBeNull();
    const text = journalNotice(advice(true))!;
    expect(text).toContain(JOURNAL_REOPEN_ADVICE);
    expect(text).toContain('편집 기록 약 1200 MiB');
    expect(text).toContain('경고선 1536 MiB');
  });
});

describe('supported document size limit (SUPPORTED_INPUT_BYTES)', () => {
  it('uses the core value (790 MiB) and notifies only when exceeded', () => {
    expect(Math.round(SUPPORTED_INPUT_BYTES / MIB)).toBe(790);
    expect(supportedSizeNotice(SUPPORTED_INPUT_BYTES)).toBeNull();
    expect(supportedSizeNotice(10 * MIB)).toBeNull();
    const text = supportedSizeNotice(SUPPORTED_INPUT_BYTES + 1)!;
    expect(text).toContain('지원 크기 790 MiB');
    expect(text).toContain('편집·저장이 실패할 수 있습니다');
    expect(supportedSizeNotice(50 * MIB, 40 * MIB)).toContain('지원 크기 40 MiB');
  });

  it('size notice integration (I3): the limit value appears only once in each text', () => {
    const count = (text: string, needle: string) => text.split(needle).length - 1;
    expect(count(supportedSizeNotice(800 * MIB)!, '790 MiB')).toBe(1);
    const warn = sizeLimitNotice(heap('warn'))!;
    const over = sizeLimitNotice(heap('over-limit', { estimatedPeakBytes: 2500 * MIB }))!;
    for (const text of [warn, over]) expect(count(text, '한계')).toBe(1);
  });

  it('the supported size line in the About dialog shows the same value', () => {
    const base = { version: '1.0.0', sourceUrl: sourceUrl('1.0.0'), noticesUrl: null, heap: null };
    expect(aboutContent(base).lines.join('\n')).toContain('약 790 MiB 까지');
    expect(aboutContent({ ...base, supportedBytes: 100 * MIB }).lines.join('\n')).toContain(
      '약 100 MiB 까지',
    );
  });
});

describe('undo notice after saving', () => {
  it('states the condition under which undo is kept but redo may be lost', () => {
    expect(HISTORY_AFTER_SAVE_NOTICE).toContain('되돌리기');
    expect(HISTORY_AFTER_SAVE_NOTICE).toContain('다시 실행');
  });
});
