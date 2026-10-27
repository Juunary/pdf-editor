import { describe, expect, it } from 'vitest';
import type { SaveHeapEstimate, SavePlan } from '@pdf-editor/shared-types';
import { fileAccessNotice, redactNotice } from '../src/viewer/notices.js';
import {
  BLOCKED_SAVE_OPTIONS,
  GROWN_HEAP_RETRY_NOTE,
  RETRY_SAVE_LABEL,
  decideSave,
} from '../src/viewer/save-plan.js';

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
  it('saves without confirmation when there is no problem', () => {
    expect(decideSave(plan())).toEqual({ block: null, warnings: [], infos: [] });
  });

  it('over-limit gives the abort notice (core message first) + what can be done, and does not recommend save and reopen', () => {
    const d = decideSave(plan({ heap: heap('over-limit', '메모리 한계 초과') }));
    expect(d.block).toBe(`메모리 한계 초과 ${BLOCKED_SAVE_OPTIONS}`);
    expect(d.block).not.toContain('저장하고');
    expect(d.warnings).toEqual([]);
    expect(decideSave(plan({ heap: heap('over-limit') })).block).toContain('저장하지 않았습니다');
  });

  it('when the over-limit basis is an already-grown heap, does not abort and shows the "그래도 저장 시도" (save anyway) confirmation (H1)', () => {
    const d = decideSave(
      plan({ heap: { ...heap('over-limit', '메모리 한계 초과'), grownHeapBasis: true } }),
    );
    expect(d.block).toBeNull();
    expect(d.warnings).toEqual(['메모리 한계 초과', GROWN_HEAP_RETRY_NOTE]);
    expect(d.confirmLabel).toBe(RETRY_SAVE_LABEL);
    // warn gets the ordinary confirmation dialog even for a grown heap.
    const w = decideSave(plan({ heap: { ...heap('warn', '경고'), grownHeapBasis: true } }));
    expect(w.confirmLabel).toBeUndefined();
  });

  it('warn is a confirmation dialog (warning text)', () => {
    const d = decideSave(plan({ heap: heap('warn', '힙 경고') }));
    expect(d.block).toBeNull();
    expect(d.warnings).toEqual(['힙 경고']);
    expect(decideSave(plan({ heap: heap('warn') })).warnings[0]).toContain('메모리를 많이 쓸');
  });

  it('a tagged paragraph with a broken structure link and PDF/A give warnings; edited page numbers give a notice', () => {
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

  it('with only edits and no warnings there is no confirmation dialog, only a notice', () => {
    const d = decideSave(
      plan({ edits: { pages: [1], structureUnlinked: 0, pdfaDeclared: false } }),
    );
    expect(d.warnings).toEqual([]);
    expect(d.infos).toHaveLength(1);
  });

  it('a core save warning (saving in a failure state) shows a confirmation dialog and comes first', () => {
    const d = decideSave(
      plan({
        warnings: [
          '편집 엔진 오류 상태에서 저장합니다.',
          '취소한 초안의 변경이 들어갈 수 있습니다.',
        ],
        heap: heap('warn', '힙'),
        edits: { pages: [0], structureUnlinked: 0, pdfaDeclared: false },
      }),
    );
    expect(d.block).toBeNull();
    expect(d.warnings).toEqual([
      '편집 엔진 오류 상태에서 저장합니다.',
      '취소한 초안의 변경이 들어갈 수 있습니다.',
      '힙',
    ]);
    expect(d.infos).toHaveLength(1);
    expect(decideSave(plan({ warnings: [] })).warnings).toEqual([]);
  });

  it('over-limit aborts even if there is a core warning', () => {
    const d = decideSave(plan({ warnings: ['x'], heap: heap('over-limit', '한계') }));
    expect(d.block).toBe(`한계 ${BLOCKED_SAVE_OPTIONS}`);
  });

  it('when warn and edit warnings overlap, all are collected', () => {
    const d = decideSave(
      plan({
        heap: heap('warn', '힙'),
        edits: { pages: [0], structureUnlinked: 1, pdfaDeclared: false },
      }),
    );
    expect(d.warnings).toHaveLength(2);
  });
});

describe('notices on open', () => {
  it('Redact annotation report (A2-2)', () => {
    expect(redactNotice(null)).toBeNull();
    expect(redactNotice({ total: 0, pages: [] })).toBeNull();
    expect(redactNotice({ total: 3, pages: [0, 4] })).toContain('Redact(가림) 주석 3개');
    expect(redactNotice({ total: 3, pages: [0, 4] })).toContain('1, 5쪽');
  });

  it('DNR path file:// guidance (A5-3): only on 128–149 when file URL access is off', () => {
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
