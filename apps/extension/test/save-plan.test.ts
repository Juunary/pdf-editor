import { describe, expect, it } from 'vitest';
import type { SaveHeapEstimate, SavePlan } from '@pdf-editor/shared-types';
import { fileAccessNotice, redactNotice } from '../src/viewer/notices.js';
import { decideSave } from '../src/viewer/save-plan.js';

const heap = (
  level: SaveHeapEstimate['level'],
  message: string | null = null,
): SaveHeapEstimate => ({
  inputBytes: 10 * 2 ** 20,
  ratio: 8,
  estimatedPeakBytes: 80 * 2 ** 20,
  limitBytes: 100 * 2 ** 20,
  fraction: 0.8,
  level,
  message,
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

describe('decideSave', () => {
  it('문제 없으면 확인 없이 저장한다', () => {
    expect(decideSave(plan())).toEqual({ block: null, warnings: [], infos: [] });
  });

  it('over-limit 은 중단 안내(코어 메시지 우선)', () => {
    const d = decideSave(plan({ heap: heap('over-limit', '메모리 한계 초과') }));
    expect(d.block).toBe('메모리 한계 초과');
    expect(d.warnings).toEqual([]);
    expect(decideSave(plan({ heap: heap('over-limit') })).block).toContain('저장하지 않습니다');
  });

  it('warn 은 확인 창(경고 문구)', () => {
    const d = decideSave(plan({ heap: heap('warn', '힙 경고') }));
    expect(d.block).toBeNull();
    expect(d.warnings).toEqual(['힙 경고']);
    expect(decideSave(plan({ heap: heap('warn') })).warnings[0]).toContain('메모리를 많이 쓸');
  });

  it('구조 연결이 끊긴 태그 문단·PDF/A 는 경고, 편집한 쪽 번호는 안내', () => {
    const d = decideSave(
      plan({ edits: { pages: [0, 2], structureUnlinked: 3, pdfaDeclared: true } }),
    );
    expect(d.warnings).toHaveLength(2);
    expect(d.warnings[0]).toContain('3개');
    expect(d.warnings[1]).toContain('PDF/A');
    expect(d.infos).toEqual([
      '저장하면 편집한 쪽 번호(1, 3쪽)가 파일 정보(PdfEditorEdits)에 기록됩니다.',
    ]);
  });

  it('편집만 있고 경고가 없으면 확인 창은 없고 안내만 있다', () => {
    const d = decideSave(
      plan({ edits: { pages: [1], structureUnlinked: 0, pdfaDeclared: false } }),
    );
    expect(d.warnings).toEqual([]);
    expect(d.infos).toHaveLength(1);
  });

  it('warn 과 편집 경고가 겹치면 모두 모은다', () => {
    const d = decideSave(
      plan({
        heap: heap('warn', '힙'),
        edits: { pages: [0], structureUnlinked: 1, pdfaDeclared: false },
      }),
    );
    expect(d.warnings).toHaveLength(2);
  });
});

describe('열기 시 알림', () => {
  it('Redact 주석 보고(A2-2)', () => {
    expect(redactNotice(null)).toBeNull();
    expect(redactNotice({ total: 0, pages: [] })).toBeNull();
    expect(redactNotice({ total: 3, pages: [0, 4] })).toContain('Redact(가림) 주석 3개');
    expect(redactNotice({ total: 3, pages: [0, 4] })).toContain('1, 5쪽');
  });

  it('DNR 경로 file:// 안내(A5-3): 128–149 에서 파일 URL 접근이 꺼져 있을 때만', () => {
    const base = {
      mode: 'dnr-fallback',
      fileAccessAllowed: false,
      displayUrl: null,
      extensionId: 'abc',
    } as const;
    expect(fileAccessNotice(base)).toContain('chrome://extensions/?id=abc');
    expect(fileAccessNotice({ ...base, displayUrl: 'file:///C:/a.pdf' })).not.toBeNull();
    expect(fileAccessNotice({ ...base, displayUrl: 'https://x.test/a.pdf' })).toBeNull();
    expect(fileAccessNotice({ ...base, fileAccessAllowed: true })).toBeNull();
    expect(fileAccessNotice({ ...base, fileAccessAllowed: null })).toBeNull();
    expect(fileAccessNotice({ ...base, mode: 'mime-handler' })).toBeNull();
    expect(fileAccessNotice({ ...base, mode: 'unsupported' })).toBeNull();
  });
});
