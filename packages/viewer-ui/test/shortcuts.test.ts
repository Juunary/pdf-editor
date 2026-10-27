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

describe('shortcut classification', () => {
  it('Ctrl+F / Cmd+F is find, case-insensitive', () => {
    expect(isFindShortcut(key('f', { ctrlKey: true }))).toBe(true);
    expect(isFindShortcut(key('F', { ctrlKey: true }))).toBe(true);
    expect(isFindShortcut(key('f', { metaKey: true }))).toBe(true);
  });

  it('it is not find if there is no modifier or Alt/Shift is mixed in', () => {
    expect(isFindShortcut(key('f'))).toBe(false);
    expect(isFindShortcut(key('f', { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isFindShortcut(key('f', { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isFindShortcut(key('g', { ctrlKey: true }))).toBe(false);
  });

  it('Ctrl+A is select all', () => {
    expect(isSelectAllShortcut(key('a', { ctrlKey: true }))).toBe(true);
    expect(isSelectAllShortcut(key('A', { metaKey: true }))).toBe(true);
    expect(isSelectAllShortcut(key('a'))).toBe(false);
    expect(isSelectAllShortcut(key('a', { ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it('input element detection', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'textarea' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'BODY' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
