import { describe, expect, it } from 'vitest';
import {
  canStep,
  clampPage,
  navDisabled,
  pageArrowLayout,
  PAGE_ARROW_GUTTER,
  parsePageInput,
  stepPage,
} from '../src/page-nav.js';
import { fitWidthScale } from '../src/layout.js';

describe('page navigation', () => {
  it('clampPage', () => {
    expect(clampPage(-3, 10)).toBe(0);
    expect(clampPage(12, 10)).toBe(9);
    expect(clampPage(4.9, 10)).toBe(4);
    expect(clampPage(Number.NaN, 10)).toBe(0);
    expect(clampPage(5, 0)).toBe(0);
  });

  it('stepPage stays in place at the ends', () => {
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

  it('parsePageInput: 1-based input, range and format validation', () => {
    expect(parsePageInput('1', 12)).toBe(0);
    expect(parsePageInput(' 12 ', 12)).toBe(11);
    expect(parsePageInput('13', 12)).toBeNull();
    expect(parsePageInput('0', 12)).toBeNull();
    expect(parsePageInput('', 12)).toBeNull();
    expect(parsePageInput('-1', 12)).toBeNull();
    expect(parsePageInput('1.5', 12)).toBeNull();
    expect(parsePageInput('3a', 12)).toBeNull();
    expect(parsePageInput('１２', 12)).toBeNull(); // full-width digits are rejected
  });
});

describe('navDisabled', () => {
  it('the previous button is disabled on the first page and the next on the last page', () => {
    expect(navDisabled(0, 3)).toEqual({ prev: true, next: false });
    expect(navDisabled(1, 3)).toEqual({ prev: false, next: false });
    expect(navDisabled(2, 3)).toEqual({ prev: false, next: true });
  });

  it('both are disabled for a one-page document', () => {
    expect(navDisabled(0, 1)).toEqual({ prev: true, next: true });
  });
});

describe('page arrow placement (user decision 2026-10-26 changed: overlap on the page when there is no room)', () => {
  it('at a document area of 464 px or more, side slots; below that, overlap on the page', () => {
    expect(pageArrowLayout(1280)).toEqual({
      placement: 'side',
      availableWidth: 1280 - 2 * PAGE_ARROW_GUTTER,
    });
    expect(pageArrowLayout(464).placement).toBe('side');
    expect(pageArrowLayout(464).availableWidth).toBe(464 - 2 * PAGE_ARROW_GUTTER);
    expect(pageArrowLayout(463)).toEqual({ placement: 'overlay', availableWidth: 463 });
    expect(pageArrowLayout(400)).toEqual({ placement: 'overlay', availableWidth: 400 });
    expect(pageArrowLayout(320)).toEqual({ placement: 'overlay', availableWidth: 320 });
  });

  it('with side slots, the page is at least the minimum width, so room is left for the slots', () => {
    for (const w of [464, 500, 800, 1280]) {
      const l = pageArrowLayout(w);
      const pageCss = fitWidthScale({ availableWidth: l.availableWidth, pageWidthPt: 612 }) * 612;
      expect(pageCss + 2 * PAGE_ARROW_GUTTER + 32, String(w)).toBeLessThanOrEqual(w + 1e-9);
    }
  });

  it('with overlap on the page, the slot share is not subtracted, so the page gets wider (400 px: 320 → 368)', () => {
    const pageCss = (w: number) =>
      fitWidthScale({ availableWidth: pageArrowLayout(w).availableWidth, pageWidthPt: 612 }) * 612;
    expect(pageCss(400)).toBeCloseTo(368, 6);
    expect(pageCss(320)).toBeCloseTo(320, 6); // minimum width
  });
});
