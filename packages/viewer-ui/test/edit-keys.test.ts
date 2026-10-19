import { describe, expect, it } from 'vitest';
import { docHistoryShortcut, mapEditKey, type EditKeyLike } from '../src/edit-keys.js';
import { regionPlacement } from '../src/edit-paint.js';
import { paragraphAt, resizeArea } from '../src/edit-geometry.js';
import type { PageLayout } from '../src/layout.js';

const key = (k: string, extra: Partial<EditKeyLike> = {}): EditKeyLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
});

describe('mapEditKey', () => {
  it('화살표·Home/End 는 Shift(선택)·Ctrl(단어·문단)을 반영한다', () => {
    expect(mapEditKey(key('ArrowLeft'))).toEqual({
      type: 'move-h',
      dir: -1,
      shift: false,
      word: false,
    });
    expect(mapEditKey(key('ArrowRight', { shiftKey: true, ctrlKey: true }))).toEqual({
      type: 'move-h',
      dir: 1,
      shift: true,
      word: true,
    });
    expect(mapEditKey(key('ArrowDown', { shiftKey: true }))).toEqual({
      type: 'move-v',
      dir: 1,
      shift: true,
    });
    expect(mapEditKey(key('Home', { ctrlKey: true }))).toEqual({
      type: 'line',
      which: 'home',
      shift: false,
      whole: true,
    });
    expect(mapEditKey(key('End', { shiftKey: true }))).toEqual({
      type: 'line',
      which: 'end',
      shift: true,
      whole: false,
    });
  });

  it('삭제·Enter·Esc·Ctrl+A·Ctrl+Z/Shift+Z/Y', () => {
    expect(mapEditKey(key('Backspace', { ctrlKey: true }))).toEqual({
      type: 'backspace',
      word: true,
    });
    expect(mapEditKey(key('Delete'))).toEqual({ type: 'delete', word: false });
    expect(mapEditKey(key('Enter'))).toEqual({ type: 'enter' });
    expect(mapEditKey(key('Enter', { ctrlKey: true }))).toBeNull();
    expect(mapEditKey(key('Escape'))).toEqual({ type: 'commit' });
    expect(mapEditKey(key('a', { ctrlKey: true }))).toEqual({ type: 'select-all' });
    expect(mapEditKey(key('A', { metaKey: true }))).toEqual({ type: 'select-all' });
    expect(mapEditKey(key('z', { ctrlKey: true }))).toEqual({ type: 'undo' });
    expect(mapEditKey(key('Z', { ctrlKey: true, shiftKey: true }))).toEqual({ type: 'redo' });
    expect(mapEditKey(key('y', { ctrlKey: true }))).toEqual({ type: 'redo' });
  });

  it('글자·Ctrl+S·Ctrl+F·Ctrl+C 등은 가로채지 않는다', () => {
    for (const k of [
      key('a'),
      key('s', { ctrlKey: true }),
      key('f', { ctrlKey: true }),
      key('c', { ctrlKey: true }),
    ]) {
      expect(mapEditKey(k)).toBeNull();
    }
  });

  it('조합 중에는 모든 키(화살표·Ctrl+Z·Esc)를 무시한다(I4·I5·I8)', () => {
    for (const k of ['ArrowLeft', 'ArrowUp', 'Backspace', 'Enter', 'Escape']) {
      expect(mapEditKey(key(k, { isComposing: true }))).toBeNull();
      expect(mapEditKey(key(k, { keyCode: 229 }))).toBeNull();
    }
    expect(mapEditKey(key('z', { ctrlKey: true, isComposing: true }))).toBeNull();
  });
});

describe('docHistoryShortcut', () => {
  it('편집 밖 문서 undo/redo 단축키', () => {
    expect(docHistoryShortcut(key('z', { ctrlKey: true }))).toBe('undo');
    expect(docHistoryShortcut(key('z', { ctrlKey: true, shiftKey: true }))).toBe('redo');
    expect(docHistoryShortcut(key('y', { ctrlKey: true }))).toBe('redo');
    expect(docHistoryShortcut(key('y', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(docHistoryShortcut(key('z'))).toBeNull();
    expect(docHistoryShortcut(key('z', { ctrlKey: true, altKey: true }))).toBeNull();
  });
});

describe('영역 핸들·문단 찾기', () => {
  const limit: [number, number, number, number] = [0, 0, 300, 200];
  it('변·모서리 드래그와 상한·최소 크기', () => {
    const area: [number, number, number, number] = [100, 50, 200, 90];
    expect(resizeArea(area, 'e', 30, 99, limit)).toEqual([100, 50, 230, 90]);
    expect(resizeArea(area, 'se', 40, 25, limit)).toEqual([100, 50, 240, 115]);
    expect(resizeArea(area, 'nw', -30, -10, limit)).toEqual([70, 40, 200, 90]);
    // 상한 밖으로 나가지 못한다
    expect(resizeArea(area, 'e', 999, 0, limit)).toEqual([100, 50, 300, 90]);
    expect(resizeArea(area, 'n', 0, -999, limit)).toEqual([100, 0, 200, 90]);
    // 최소 크기
    expect(resizeArea(area, 'w', 999, 0, limit, 20)).toEqual([180, 50, 200, 90]);
    expect(resizeArea(area, 's', 0, -999, limit, 20, 8)).toEqual([100, 50, 200, 58]);
  });

  it('점이 놓인 가장 안쪽 문단', () => {
    const ps = [
      { id: 1, bbox: [0, 0, 100, 100] as [number, number, number, number] },
      { id: 2, bbox: [10, 10, 40, 40] as [number, number, number, number] },
    ];
    expect(paragraphAt(ps, [20, 20])?.id).toBe(2);
    expect(paragraphAt(ps, [60, 60])?.id).toBe(1);
    expect(paragraphAt(ps, [200, 200])).toBeNull();
  });
});

describe('변경 영역 합성 위치', () => {
  const layout: PageLayout = {
    cssScale: 1.5,
    devicePixelRatio: 2,
    origin: [0, 0],
    cssWidth: 900,
    cssHeight: 1200,
    bitmapWidth: 1800,
    bitmapHeight: 2400,
  };
  const region = (clip: [number, number, number, number] | null) => ({
    pageIndex: 0,
    width: 10,
    height: 10,
    rgba: new Uint8ClampedArray(400),
    renderMs: 1,
    clip,
  });

  it('clip(페이지 공간)을 렌더 배율(CSS 배율 × dpr)로 환산한다', () => {
    expect(regionPlacement(region([100, 50, 200, 90]), layout)).toEqual({ x: 300, y: 150 });
    expect(regionPlacement(region(null), layout)).toEqual({ x: 0, y: 0 });
    expect(regionPlacement(region([10, 10, 20, 20]), { ...layout, origin: [10, 10] })).toEqual({
      x: 0,
      y: 0,
    });
  });
});
