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

describe('편집 제한 사유 표(사용자 결정 2026-10-26)', () => {
  it('한국어·영어 표가 사유 코드 30종 전부를 같은 키로 가진다', () => {
    const all = [
      ...new Set([...PARAGRAPH_LIMIT_REASONS, ...EDIT_LIMIT_REASONS, ...PATH_LIMIT_REASONS]),
    ].sort();
    expect(all).toHaveLength(30);
    expect(Object.keys(LIMIT_LABELS).sort()).toEqual(all);
    expect(Object.keys(LIMIT_LABELS_EN).sort()).toEqual(all);
    for (const v of Object.values(LIMIT_LABELS_EN)) expect(v).not.toMatch(HANGUL);
  });

  it('limitLabel 은 화면 언어 표를 쓰고 모르는 코드는 코드를 적는다', () => {
    expect(limitLabel('type3-font')).toBe('Type3 글꼴은 편집할 수 없습니다.');
    expect(limitLabel('type3-font', en)).toBe('Type3 fonts cannot be edited.');
    expect(limitLabel('x-new', en)).toBe('Cannot be edited (x-new)');
    expect(limitLabel('x-new')).toBe('편집할 수 없습니다 (x-new)');
  });

  it('limitItems: 한국어는 core 설명(detail), 영어는 사유 코드 문구, 중복 제거·빈 목록은 대체 문구', () => {
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

describe('편집 경고 문구', () => {
  const w = (partial: Partial<EditWarning>): EditWarning => ({
    kind: 'link-overlap',
    message: '편집 문단과 겹치는 링크 2개는 그대로 남습니다(영역을 다시 계산하지 않음).',
    rects: [
      [0, 0, 1, 1],
      [2, 2, 3, 3],
    ],
    ...partial,
  });

  it('한국어·영어 표의 키가 같고 영어에는 한글이 없다', () => {
    expect(Object.keys(WARNING_TEXTS_EN).sort()).toEqual(Object.keys(WARNING_TEXTS_KO).sort());
    for (const f of Object.values(WARNING_TEXTS_EN)) expect(f(3, 'xy')).not.toMatch(HANGUL);
  });

  it('한국어는 core 문장 그대로, 영어는 종류·수치(count 없으면 rects 수)로 만든다', () => {
    expect(warningText(w({}), ko)).toBe(w({}).message);
    expect(warningText(w({}), en)).toBe(
      '2 link(s) overlapping the edited paragraph stay as they are (their areas are not recalculated).',
    );
    expect(
      warningText(w({ kind: 'font-fallback', count: 3, chars: 'ABC', message: 'x' }), en),
    ).toBe('3 character(s) missing from the original font are drawn with the fallback font: ABC');
    expect(warningText(w({ kind: 'glyph-missing', chars: '☃' }), en)).toContain(': ☃');
  });

  it('같은 종류의 경우(variant)를 구별한다', () => {
    const base = { kind: 'tagged-structure-unlinked' as const };
    expect(warningText(w(base), en)).toContain('not linked to the tagged PDF structure');
    expect(warningText(w({ ...base, variant: 'form-clone' }), en)).toContain('/StructParents');
    expect(warningText(w({ ...base, variant: 'path-removed' }), en)).toContain(
      'Deletes a path inside tagged',
    );
    // core 문장이 비어 있으면 한국어도 표로 만든다.
    expect(warningText(w({ message: '' }), ko)).toBe(WARNING_TEXTS_KO['link-overlap'](2, ''));
  });
});

describe('편집 가능 표시 툴팁', () => {
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

  it('영어 표를 주면 종류·사유가 영어', () => {
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

describe('오류 상세(영어 화면)', () => {
  it('오류 이름 → 문장', () => {
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

  it('알려진 메시지 형태는 수치를 살려 옮긴다', () => {
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

  it('한글이 없는 메시지는 그대로, 모르는 한국어 메시지는 일반 문장', () => {
    expect(errorDetailEn(new Error('cannot open document'))).toBe('cannot open document');
    expect(errorDetailEn('NotAllowedError: The request is not allowed')).toBe(
      'NotAllowedError: The request is not allowed',
    );
    expect(errorDetailEn(new Error('로그와 MuPDF 저널이 어긋남: undo 불가'))).toBe(
      'An internal error occurred.',
    );
  });

  it('한국어 화면은 메시지 그대로', () => {
    expect(ko.errorDetail(new Error('PDF 요청 실패: HTTP 404'))).toBe('PDF 요청 실패: HTTP 404');
    expect(ko.errorDetail('x')).toBe('x');
  });
});
