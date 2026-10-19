import { describe, expect, it } from 'vitest';
import { WORKER_RECOVERED_ERROR_NAME, classifyFailure } from '../src/failure.js';

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

  it('"M3 미구현" 예외도 unimplemented', () => {
    expect(classifyFailure(new Error('M3 미구현: core.getPageEditability')).kind).toBe(
      'unimplemented',
    );
  });

  it('복구 알림 오류(WorkerRecoveredError)는 recovered', () => {
    const e = new Error('복구했습니다');
    e.name = WORKER_RECOVERED_ERROR_NAME;
    expect(classifyFailure(e)).toEqual({ kind: 'recovered', message: '복구했습니다' });
    // 이름이 같아도 Error 가 아니면 일반 오류
    expect(classifyFailure({ name: WORKER_RECOVERED_ERROR_NAME, message: 'x' }).kind).toBe('error');
  });
});
