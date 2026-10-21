import { describe, expect, it } from 'vitest';
import type { SaveHeapEstimate } from '@pdf-editor/shared-types';
import { aboutContent } from '../src/viewer/about.js';
import { HISTORY_AFTER_SAVE_NOTICE, sizeLimitNotice } from '../src/viewer/notices.js';
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

describe('정보 대화상자', () => {
  const base = { version: '1.0.0', sourceUrl: sourceUrl('1.0.0'), noticesUrl: null, heap: null };

  it('버전·라이선스·버전 태그 소스 링크를 담는다', () => {
    const c = aboutContent(base);
    expect(c.lines[0]).toBe('버전 1.0.0');
    expect(c.lines.join('\n')).toContain('AGPL-3.0-or-later');
    expect(c.links[0]).toEqual({
      label: '소스 코드 (v1.0.0)',
      href: 'https://github.com/Juunary/pdf-editor/tree/v1.0.0',
    });
  });

  it('고지 링크는 URL 이 있을 때만, 문서 크기 줄은 판정이 있을 때만 보인다', () => {
    expect(aboutContent(base).links).toHaveLength(1);
    const c = aboutContent({
      ...base,
      noticesUrl: 'chrome-extension://x/THIRD_PARTY_NOTICES.txt',
      heap: heap('warn'),
    });
    expect(c.links.map((l) => l.label)).toContain('서드파티 라이선스 고지');
    expect(c.lines.at(-1)).toContain('1600 MiB / 한계 2048 MiB');
  });

  it('지원 크기·편집 기록·되돌리기 소실 안내를 담는다', () => {
    const text = aboutContent(base).lines.join('\n');
    expect(text).toContain('지원 문서 크기');
    expect(text).toContain('편집 기록');
    expect(text).toContain('되돌리기 기록이 사라집니다');
    expect(text).toContain('다시 실행 기록이 사라집니다');
  });
});

describe('지원 크기 안내', () => {
  it('ok 는 알림이 없고 warn·over-limit 은 수치와 결과를 알린다', () => {
    expect(sizeLimitNotice(heap('ok'))).toBeNull();
    expect(sizeLimitNotice(null)).toBeNull();
    expect(sizeLimitNotice(heap('warn'))).toContain('편집·저장이 실패할 수 있습니다');
    expect(sizeLimitNotice(heap('over-limit', { estimatedPeakBytes: 2500 * MIB }))).toContain(
      '저장할 수 없습니다',
    );
  });
});

describe('저널 상한 안내', () => {
  const plan = (h: SaveHeapEstimate) => ({
    method: 'full' as const,
    options: 'x',
    reason: 'x',
    canBeSavedIncrementally: false,
    heap: h,
    edits: null,
  });

  it('힙이 ok 가 아니고 저널 보유 추정이 있으면 저장 후 다시 열기를 권한다', () => {
    expect(decideSave(plan(heap('warn', { journalBytes: 300 * MIB }))).infos).toContain(
      JOURNAL_REOPEN_ADVICE,
    );
    expect(decideSave(plan(heap('over-limit', { journalBytes: 300 * MIB }))).block).toContain(
      JOURNAL_REOPEN_ADVICE,
    );
  });

  it('ok 이거나 저널 추정이 없으면 붙이지 않는다', () => {
    expect(decideSave(plan(heap('ok', { journalBytes: 300 * MIB }))).infos).toEqual([]);
    expect(decideSave(plan(heap('warn'))).infos).toEqual([]);
  });
});

describe('저장 뒤 되돌리기 안내', () => {
  it('되돌리기는 유지되고 다시 실행이 사라질 수 있는 조건을 말한다', () => {
    expect(HISTORY_AFTER_SAVE_NOTICE).toContain('되돌리기');
    expect(HISTORY_AFTER_SAVE_NOTICE).toContain('다시 실행');
  });
});
