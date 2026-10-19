import { describe, expect, it } from 'vitest';
import { EDIT_LIMIT_REASONS, type EditLimitReason } from '../src/index.js';

describe('M1 계약', () => {
  it('편집 제한 사유는 중복 없이 고정 목록이다', () => {
    expect(new Set(EDIT_LIMIT_REASONS).size).toBe(EDIT_LIMIT_REASONS.length);
    const sample: EditLimitReason = 'unmatched';
    expect(EDIT_LIMIT_REASONS).toContain(sample);
  });
});
