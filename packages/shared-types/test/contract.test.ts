import { describe, expect, it } from 'vitest';
import {
  EDIT_LIMIT_REASONS,
  PARAGRAPH_LIMIT_REASONS,
  PATH_LIMIT_REASONS,
  REMOVE_SKIP_CODES,
  type EditLimitReason,
} from '../src/index.js';

describe('M1 contract', () => {
  it('edit limit reasons are a fixed list without duplicates', () => {
    expect(new Set(EDIT_LIMIT_REASONS).size).toBe(EDIT_LIMIT_REASONS.length);
    const sample: EditLimitReason = 'unmatched';
    expect(EDIT_LIMIT_REASONS).toContain(sample);
  });
});

describe('M3 contract', () => {
  it('paragraph edit limit reasons and removal skip codes are a fixed list without duplicates and do not overlap operation-level reasons', () => {
    expect(new Set(PARAGRAPH_LIMIT_REASONS).size).toBe(PARAGRAPH_LIMIT_REASONS.length);
    expect(new Set(REMOVE_SKIP_CODES).size).toBe(REMOVE_SKIP_CODES.length);
    const opReasons: readonly string[] = EDIT_LIMIT_REASONS;
    for (const r of PARAGRAPH_LIMIT_REASONS) expect(opReasons).not.toContain(r);
  });
});

describe('M4 contract', () => {
  it('path edit limit reasons are a fixed list without duplicates and do not overlap operation-level reasons', () => {
    expect(new Set(PATH_LIMIT_REASONS).size).toBe(PATH_LIMIT_REASONS.length);
    const opReasons: readonly string[] = EDIT_LIMIT_REASONS;
    for (const r of PATH_LIMIT_REASONS) expect(opReasons).not.toContain(r);
  });
  it('path reasons do not overlap paragraph reasons except singular-ctm (contract 4.2 defines it in both)', () => {
    const paragraphReasons: readonly string[] = PARAGRAPH_LIMIT_REASONS;
    const shared = PATH_LIMIT_REASONS.filter((r) => paragraphReasons.includes(r));
    expect(shared).toEqual(['singular-ctm']);
  });
});
