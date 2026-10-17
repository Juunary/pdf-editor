import { describe, expect, it } from 'vitest';
import { decideSaveMethod, FULL_SAVE_OPTIONS } from '../src/save-method.js';

describe('decideSaveMethod', () => {
  it('redaction 이 있으면 엔진 판단과 무관하게 전체 저장', () => {
    const d = decideSaveMethod(['redaction', 'font-embed'], true);
    expect(d.method).toBe('full');
    expect(d.options).toBe(FULL_SAVE_OPTIONS);
  });

  it('canBeSavedIncrementally=false 이면 전체 저장', () => {
    expect(decideSaveMethod(['annotation'], false).method).toBe('full');
  });

  it('주석·메타데이터만 바뀌면 증분 저장', () => {
    const d = decideSaveMethod(['annotation', 'metadata'], true);
    expect(d.method).toBe('incremental');
    expect(d.options).toBe('incremental');
  });

  it('콘텐츠 스트림·폰트 변경은 전체 저장', () => {
    expect(decideSaveMethod(['content-stream'], true).method).toBe('full');
    expect(decideSaveMethod(['font-embed'], true).method).toBe('full');
  });
});
