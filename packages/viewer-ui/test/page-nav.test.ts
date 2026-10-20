import { describe, expect, it } from 'vitest';
import { canStep, clampPage, navDisabled, parsePageInput, stepPage } from '../src/page-nav.js';

describe('페이지 이동', () => {
  it('clampPage', () => {
    expect(clampPage(-3, 10)).toBe(0);
    expect(clampPage(12, 10)).toBe(9);
    expect(clampPage(4.9, 10)).toBe(4);
    expect(clampPage(Number.NaN, 10)).toBe(0);
    expect(clampPage(5, 0)).toBe(0);
  });

  it('stepPage 는 끝에서 제자리', () => {
    expect(stepPage(0, -1, 5)).toBe(0);
    expect(stepPage(4, 1, 5)).toBe(4);
    expect(stepPage(2, 1, 5)).toBe(3);
    expect(stepPage(2, -1, 5)).toBe(1);
  });

  it('canStep', () => {
    expect(canStep(0, -1, 5)).toBe(false);
    expect(canStep(4, 1, 5)).toBe(false);
    expect(canStep(2, 1, 5)).toBe(true);
    expect(canStep(0, 1, 1)).toBe(false);
  });

  it('parsePageInput: 1부터 입력, 범위·형식 검증', () => {
    expect(parsePageInput('1', 12)).toBe(0);
    expect(parsePageInput(' 12 ', 12)).toBe(11);
    expect(parsePageInput('13', 12)).toBeNull();
    expect(parsePageInput('0', 12)).toBeNull();
    expect(parsePageInput('', 12)).toBeNull();
    expect(parsePageInput('-1', 12)).toBeNull();
    expect(parsePageInput('1.5', 12)).toBeNull();
    expect(parsePageInput('3a', 12)).toBeNull();
    expect(parsePageInput('１２', 12)).toBeNull(); // 전각 숫자는 거부
  });
});

describe('navDisabled', () => {
  it('첫 쪽은 이전, 마지막 쪽은 다음이 비활성', () => {
    expect(navDisabled(0, 3)).toEqual({ prev: true, next: false });
    expect(navDisabled(1, 3)).toEqual({ prev: false, next: false });
    expect(navDisabled(2, 3)).toEqual({ prev: false, next: true });
  });

  it('한 쪽짜리 문서는 둘 다 비활성', () => {
    expect(navDisabled(0, 1)).toEqual({ prev: true, next: true });
  });
});
