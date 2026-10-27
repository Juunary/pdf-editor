import { describe, expect, it } from 'vitest';
import { WORKER_RECOVERED_ERROR_NAME, classifyFailure } from '../src/failure.js';

describe('classifyFailure', () => {
  it('an "M1 미구현" exception is unimplemented', () => {
    expect(classifyFailure(new Error('M1 미구현: core extractPage'))).toEqual({
      kind: 'unimplemented',
      message: 'M1 미구현: core extractPage',
    });
  });

  it('any other error is error', () => {
    expect(classifyFailure(new Error('boom')).kind).toBe('error');
    expect(classifyFailure('문자열 오류')).toEqual({ kind: 'error', message: '문자열 오류' });
    expect(classifyFailure(42).message).toBe('42');
  });

  it('an "M3 미구현" exception is also unimplemented', () => {
    expect(classifyFailure(new Error('M3 미구현: core.getPageEditability')).kind).toBe(
      'unimplemented',
    );
  });

  it('a recovery notification error (WorkerRecoveredError) is recovered', () => {
    const e = new Error('복구했습니다');
    e.name = WORKER_RECOVERED_ERROR_NAME;
    expect(classifyFailure(e)).toEqual({ kind: 'recovered', message: '복구했습니다' });
    // Even with the same name, it is a plain error if it is not an Error
    expect(classifyFailure({ name: WORKER_RECOVERED_ERROR_NAME, message: 'x' }).kind).toBe('error');
  });
});
