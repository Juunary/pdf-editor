import { describe, expect, it } from 'vitest';
import { isFindShortcut, isSelectAllShortcut, isTypingTarget } from '../src/shortcuts.js';

const key = (
  k: string,
  mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {},
) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('단축키 판정', () => {
  it('Ctrl+F / Cmd+F 는 찾기, 대소문자 무관', () => {
    expect(isFindShortcut(key('f', { ctrlKey: true }))).toBe(true);
    expect(isFindShortcut(key('F', { ctrlKey: true }))).toBe(true);
    expect(isFindShortcut(key('f', { metaKey: true }))).toBe(true);
  });

  it('수식키가 없거나 Alt/Shift 가 섞이면 찾기가 아니다', () => {
    expect(isFindShortcut(key('f'))).toBe(false);
    expect(isFindShortcut(key('f', { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isFindShortcut(key('f', { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isFindShortcut(key('g', { ctrlKey: true }))).toBe(false);
  });

  it('Ctrl+A 는 전체 선택', () => {
    expect(isSelectAllShortcut(key('a', { ctrlKey: true }))).toBe(true);
    expect(isSelectAllShortcut(key('A', { metaKey: true }))).toBe(true);
    expect(isSelectAllShortcut(key('a'))).toBe(false);
    expect(isSelectAllShortcut(key('a', { ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it('입력 요소 판별', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'textarea' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'BODY' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
