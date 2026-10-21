/** 벤치 전용 WASM 사용 중 힙 측정(`probeWasmHeap`, 계약 D1 사용자 결정 2026-10-21). */
import { describe, expect, it } from 'vitest';
import { PdfSession, wasmHeapBytes } from '../src/index.js';
import { probeWasmHeap } from '../src/bench-memory.js';
import { MEDIABOX, PAGE } from './edit-harness.js';
import { buildPdf } from './pdf-fixtures.js';

describe('probeWasmHeap', () => {
  it('선형 메모리를 늘리지 않고 사용 중 힙 = 선형 − 빈 공간을 돌려주며, 측정 뒤에도 문서를 계속 쓸 수 있다', () => {
    const s = new PdfSession();
    s.open(buildPdf(Array.from({ length: 3 }, () => ({ content: PAGE, mediabox: MEDIABOX }))));
    for (let i = 0; i < 3; i++) s.renderPage({ pageIndex: i, scale: 2 });
    const before = wasmHeapBytes()!;
    const probe = probeWasmHeap({ emptyStore: true })!;
    expect(probe).not.toBeNull();
    expect(probe.emptiedStore).toBe(true);
    expect(probe.linearBytes).toBe(before);
    expect(wasmHeapBytes()).toBe(before);
    expect(probe.usedBytes).toBe(probe.linearBytes - probe.freeBytes);
    expect(probe.usedBytes).toBeGreaterThan(0);
    expect(probe.freeBytes).toBeGreaterThanOrEqual(0);
    // 두 번 재도 같은 값(받은 조각은 모두 돌려준다).
    expect(probeWasmHeap()!.usedBytes).toBe(probe.usedBytes);
    // 확장 금지는 측정 중에만: 이후 할당·렌더·저장이 된다.
    expect(s.renderPage({ pageIndex: 0, scale: 3 }).width).toBeGreaterThan(0);
    expect(s.save({ changes: [] }).bytes.byteLength).toBeGreaterThan(0);
    s.close();
  });
});
