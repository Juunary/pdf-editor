import { describe, expect, it } from 'vitest';
import {
  EDIT_LIMIT_REASONS,
  PARAGRAPH_LIMIT_REASONS,
  REMOVE_SKIP_CODES,
  type EditLimitReason,
} from '../src/index.js';

describe('M1 계약', () => {
  it('편집 제한 사유는 중복 없이 고정 목록이다', () => {
    expect(new Set(EDIT_LIMIT_REASONS).size).toBe(EDIT_LIMIT_REASONS.length);
    const sample: EditLimitReason = 'unmatched';
    expect(EDIT_LIMIT_REASONS).toContain(sample);
  });
});

describe('M3 계약', () => {
  it('문단 편집 제한 사유·제거 건너뜀 코드는 중복 없이 고정 목록이고 연산 단위 사유와 겹치지 않는다', () => {
    expect(new Set(PARAGRAPH_LIMIT_REASONS).size).toBe(PARAGRAPH_LIMIT_REASONS.length);
    expect(new Set(REMOVE_SKIP_CODES).size).toBe(REMOVE_SKIP_CODES.length);
    const opReasons: readonly string[] = EDIT_LIMIT_REASONS;
    for (const r of PARAGRAPH_LIMIT_REASONS) expect(opReasons).not.toContain(r);
  });
});
