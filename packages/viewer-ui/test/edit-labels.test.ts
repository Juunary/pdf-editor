import { describe, expect, it } from 'vitest';
import {
  EDIT_LIMIT_REASONS,
  PARAGRAPH_LIMIT_REASONS,
  PATH_LIMIT_REASONS,
  type EditWarning,
} from '@pdf-editor/shared-types';
import {
  LIMIT_LABELS,
  LIMIT_LABELS_EN,
  WARNING_TEXTS_EN,
  WARNING_TEXTS_KO,
  limitItems,
  limitLabel,
  warningText,
} from '../src/edit-labels.js';
import { buildMarks, markTip } from '../src/edit-marks.js';
import { errorDetailEn } from '../src/error-text.js';
import { VIEWER_STRINGS } from '../src/strings.js';

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;
const en = VIEWER_STRINGS.en;
const ko = VIEWER_STRINGS.ko;

describe('edit restriction reason table (user decision 2026-10-26)', () => {
  it('the Korean and English tables have all 30 reason codes under the same keys', () => {
    const all = [
      ...new Set([...PARAGRAPH_LIMIT_REASONS, ...EDIT_LIMIT_REASONS, ...PATH_LIMIT_REASONS]),
    ].sort();
    expect(all).toHaveLength(30);
    expect(Object.keys(LIMIT_LABELS).sort()).toEqual(all);
    expect(Object.keys(LIMIT_LABELS_EN).sort()).toEqual(all);
    for (const v of Object.values(LIMIT_LABELS_EN)) expect(v).not.toMatch(HANGUL);
  });

  it('limitLabel uses the display-language table and writes the code for an unknown code', () => {
    expect(limitLabel('type3-font')).toBe('Type3 글꼴은 편집할 수 없습니다.');
    expect(limitLabel('type3-font', en)).toBe('Type3 fonts cannot be edited.');
    expect(limitLabel('x-new', en)).toBe('Cannot be edited (x-new)');
    expect(limitLabel('x-new')).toBe('편집할 수 없습니다 (x-new)');
  });

  it('limitItems: Korean uses the core description (detail), English uses the reason-code text; duplicates are removed and an empty list gets a fallback text', () => {
    const limits = [
      { reason: 'clip-path', detail: '클립 경로(W·W*)를 겸하는 칠하기' },
      { reason: 'clip-path', detail: '클립 경로(W·W*)를 겸하는 칠하기' },
      { reason: 'soft-mask', detail: '' },
    ];
    expect(limitItems(limits, ko.pathNotEditable, ko)).toEqual([
      '클립 경로(W·W*)를 겸하는 칠하기',
      LIMIT_LABELS['soft-mask'],
    ]);
    expect(limitItems(limits, en.pathNotEditable, en)).toEqual([
      LIMIT_LABELS_EN['clip-path'],
      LIMIT_LABELS_EN['soft-mask'],
    ]);
    expect(limitItems([], en.pathNotEditable, en)).toEqual(['This path cannot be edited.']);
  });
});

describe('edit warning text', () => {
  const w = (partial: Partial<EditWarning>): EditWarning => ({
    kind: 'link-overlap',
    message: '편집 문단과 겹치는 링크 2개는 그대로 남습니다(영역을 다시 계산하지 않음).',
    rects: [
      [0, 0, 1, 1],
      [2, 2, 3, 3],
    ],
    ...partial,
  });

  it('the Korean and English table keys are the same and English has no Hangul', () => {
    expect(Object.keys(WARNING_TEXTS_EN).sort()).toEqual(Object.keys(WARNING_TEXTS_KO).sort());
    for (const f of Object.values(WARNING_TEXTS_EN)) expect(f(3, 'xy')).not.toMatch(HANGUL);
  });

  it('Korean uses the core sentence as is; English is built from the kind and numbers (the rects count if there is no count)', () => {
    expect(warningText(w({}), ko)).toBe(w({}).message);
    expect(warningText(w({}), en)).toBe(
      '2 link(s) overlapping the edited paragraph stay as they are (their areas are not recalculated).',
    );
    expect(
      warningText(w({ kind: 'font-fallback', count: 3, chars: 'ABC', message: 'x' }), en),
    ).toBe('3 character(s) missing from the original font are drawn with the fallback font: ABC');
    expect(warningText(w({ kind: 'glyph-missing', chars: '☃' }), en)).toContain(': ☃');
  });

  it('distinguishes cases (variant) of the same kind', () => {
    const base = { kind: 'tagged-structure-unlinked' as const };
    expect(warningText(w(base), en)).toContain('not linked to the tagged PDF structure');
    expect(warningText(w({ ...base, variant: 'form-clone' }), en)).toContain('/StructParents');
    expect(warningText(w({ ...base, variant: 'path-removed' }), en)).toContain(
      'Deletes a path inside tagged',
    );
    // If the core sentence is empty, Korean is also built from the table.
    expect(warningText(w({ message: '' }), ko)).toBe(WARNING_TEXTS_KO['link-overlap'](2, ''));
  });
});

describe('editability overlay tooltip', () => {
  const editability = {
    pageIndex: 0,
    revision: 1,
    paragraphs: [
      {
        paragraphId: 1,
        bbox: [0, 0, 10, 10] as [number, number, number, number],
        editable: false,
        editedBlock: null,
        reasons: ['tagged-content' as const],
        cell: { table: 0, row: 0, col: 0 },
      },
    ],
    paths: [],
    ms: 0,
  };

  it('given the English table, the kind and reason are in English', () => {
    const { marks } = buildMarks(editability, 10, en);
    expect(markTip(marks[0]!, en)).toBe(
      'Table cell · Restricted: The text is inside a tagged structure.',
    );
    expect(markTip({ ...marks[0]!, editable: true }, en)).toBe('Table cell · Editable');
    expect(markTip({ ...marks[0]!, reasons: [] }, en)).toBe(
      'Table cell · Restricted: Cannot be edited',
    );
    expect(markTip(buildMarks(editability).marks[0]!)).toBe(
      '표 셀 · 제한: 태그된 구조 안의 글자입니다.',
    );
  });
});

describe('error details (English display)', () => {
  it('error name → sentence', () => {
    const e = new Error('작업 모듈이 복구되어 초안 d1 이 사라졌습니다(commit)');
    e.name = 'WorkerRecoveredError';
    expect(errorDetailEn(e)).toBe('The worker stopped and the document was recovered.');
    const f = new Error('문서를 복구하지 못했습니다. 파일을 다시 열어 주세요: x');
    f.name = 'RecoveryFailedError';
    expect(errorDetailEn(f)).toBe('Could not recover the document. Reopen the file.');
    expect(errorDetailEn('StaleRevisionError: 문서가 바뀌었습니다(revision 3, 요청 2)')).toBe(
      'The document changed. Try again.',
    );
  });

  it('known message shapes are translated keeping the numbers', () => {
    expect(errorDetailEn(new Error('PDF 요청 실패: HTTP 404'))).toBe(
      'PDF request failed: HTTP 404',
    );
    expect(errorDetailEn('Error: 폴백 폰트를 받지 못했습니다: HTTP 503')).toBe(
      'Could not load the fallback font: HTTP 503',
    );
    expect(
      errorDetailEn(
        new Error('편집 초안이 열려 있어 저장할 수 없습니다. 먼저 커밋하거나 취소하세요.'),
      ),
    ).toContain('cannot be saved');
    expect(errorDetailEn(new Error('M3 미구현: core.planParagraphEdit'))).toBe(
      'not implemented in this build',
    );
  });

  it('a message without Hangul is passed through, and an unknown Korean message becomes a generic sentence', () => {
    expect(errorDetailEn(new Error('cannot open document'))).toBe('cannot open document');
    expect(errorDetailEn('NotAllowedError: The request is not allowed')).toBe(
      'NotAllowedError: The request is not allowed',
    );
    expect(errorDetailEn(new Error('로그와 MuPDF 저널이 어긋남: undo 불가'))).toBe(
      'An internal error occurred.',
    );
  });

  it('the Korean display passes the message through as is', () => {
    expect(ko.errorDetail(new Error('PDF 요청 실패: HTTP 404'))).toBe('PDF 요청 실패: HTTP 404');
    expect(ko.errorDetail('x')).toBe('x');
  });
});
