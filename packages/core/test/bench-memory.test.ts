/** Bench-only measurement of the in-use WASM heap (`probeWasmHeap`, contract D1 user decision 2026-10-21). */
import { describe, expect, it } from 'vitest';
import { PdfSession, wasmHeapBytes } from '../src/index.js';
import { probeWasmHeap } from '../src/bench-memory.js';
import { MEDIABOX, PAGE } from './edit-harness.js';
import { buildPdf } from './pdf-fixtures.js';

describe('probeWasmHeap', () => {
  it('returns in-use heap = linear − free space without growing linear memory, and the document stays usable after measuring', () => {
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
    // Measuring twice gives the same value (every chunk obtained is returned).
    expect(probeWasmHeap()!.usedBytes).toBe(probe.usedBytes);
    // The no-growth rule applies only while measuring: allocation, render and save work afterwards.
    expect(s.renderPage({ pageIndex: 0, scale: 3 }).width).toBeGreaterThan(0);
    expect(s.save({ changes: [] }).bytes.byteLength).toBeGreaterThan(0);
    s.close();
  });
});
