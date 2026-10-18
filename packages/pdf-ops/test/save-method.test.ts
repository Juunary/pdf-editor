import { describe, expect, it } from 'vitest';
import {
  decideSaveMethod,
  estimateSaveHeap,
  FULL_SAVE_OPTIONS,
  MEASURED_PEAK_HEAP_RATIO,
  STREAM_INPUT_PEAK_HEAP_RATIO,
  WASM_HEAP_LIMIT_BYTES,
} from '../src/save-method.js';

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

describe('decideSaveMethod: 예상 피크 힙(파일 크기 × 실측 배율)', () => {
  const MIB = 2 ** 20;

  it('size 를 넘기지 않으면 heap 없음(기존 호출 호환)', () => {
    expect(decideSaveMethod(['redaction'], false).heap).toBeUndefined();
  });

  it('전체 저장 배율 4.48, 증분 3.98(docs/m0-day1-log.md 6.5)', () => {
    expect(MEASURED_PEAK_HEAP_RATIO).toEqual({ full: 4.48, incremental: 3.98 });
    const d = decideSaveMethod(['redaction'], false, { inputBytes: 100 * MIB });
    expect(d.heap).toMatchObject({ ratio: 4.48, estimatedPeakBytes: Math.ceil(100 * MIB * 4.48) });
    expect(d.heap!.level).toBe('ok');
    expect(d.heap!.message).toBeNull();
    const i = decideSaveMethod(['annotation'], true, { inputBytes: 100 * MIB });
    expect(i.method).toBe('incremental');
    expect(i.heap!.ratio).toBe(3.98);
  });

  it('상한 2 GiB 의 75% 초과 → warn, 100% 초과 → over-limit. 저장 방식은 바꾸지 않는다', () => {
    expect(WASM_HEAP_LIMIT_BYTES).toBe(2147483648);
    // 2048 MiB × 0.75 / 4.48 = 342.9 MiB, 2048 / 4.48 = 457.1 MiB
    expect(estimateSaveHeap('full', { inputBytes: 342 * MIB }).level).toBe('ok');
    expect(estimateSaveHeap('full', { inputBytes: 343 * MIB }).level).toBe('warn');
    expect(estimateSaveHeap('full', { inputBytes: 457 * MIB }).level).toBe('warn');
    const over = decideSaveMethod(['content-stream'], true, { inputBytes: 458 * MIB });
    expect(over.method).toBe('full');
    expect(over.heap!.level).toBe('over-limit');
    expect(over.heap!.message).toMatch(/상한 2048 MiB 를 넘습니다/);
    expect(estimateSaveHeap('full', { inputBytes: 400 * MIB }).message).toMatch(/88%/);
  });

  it('Stream 입력 배율(3.48)을 넘기면 상한 초과 경계가 588 MiB 로 올라간다', () => {
    const ratio = STREAM_INPUT_PEAK_HEAP_RATIO;
    expect(estimateSaveHeap('full', { inputBytes: 588 * MIB, ratio }).level).toBe('warn');
    expect(estimateSaveHeap('full', { inputBytes: 589 * MIB, ratio }).level).toBe('over-limit');
  });

  it('상한·경고 비율·배율을 바꿀 수 있다', () => {
    const e = estimateSaveHeap('full', {
      inputBytes: 100 * MIB,
      limitBytes: 512 * MIB,
      warnFraction: 0.5,
      ratio: { full: 3 },
    });
    expect(e).toMatchObject({ ratio: 3, fraction: 300 / 512, level: 'warn' });
  });
});
