import { describe, expect, it } from 'vitest';
import { classifyFailure } from '../src/failure.js';

describe('classifyFailure', () => {
  it('"M1 미구현" 예외는 unimplemented', () => {
    expect(classifyFailure(new Error('M1 미구현: core extractPage'))).toEqual({
      kind: 'unimplemented',
      message: 'M1 미구현: core extractPage',
    });
  });

  it('그 밖의 오류는 error', () => {
    expect(classifyFailure(new Error('boom')).kind).toBe('error');
    expect(classifyFailure('문자열 오류')).toEqual({ kind: 'error', message: '문자열 오류' });
    expect(classifyFailure(42).message).toBe('42');
  });
});
