/**
 * Bench-only WASM heap measurement (contract D1 and 4.1 user decision 2026-10-21, docs/m5-followup.md). Not included in the store build:
 * the extension's Worker entry point dynamically imports this module only in dev builds and exposes it via the `benchProbeHeap` RPC.
 *
 * WASM linear memory never shrinks, so after clearing the MuPDF cache (`emptyStore`) the value is measured as the "heap in use" rather than the linear memory size:
 * with linear memory growth blocked, free space is requested with `_wasm_malloc` from the largest chunks down (16 MiB -> 1 MiB -> 64 KiB), and everything is
 * returned. In use = linear memory − total obtained. Free chunks smaller than 64 KiB count as in use (error on the overestimate side).
 * MuPDF's malloc clears the resource cache (scavenge) and retries on failure, so this measurement reflects the state with the cache cleared.
 */
import './wasm-module.js';
import * as mupdf from 'mupdf';
import { libmupdfModule } from './wasm-module.js';

export interface WasmHeapProbe {
  /** Linear memory size (bytes, the maximum, which never shrinks). The measurement does not grow linear memory. */
  linearBytes: number;
  /** Total free space obtained (bytes). */
  freeBytes: number;
  /** linearBytes − freeBytes. */
  usedBytes: number;
  /** Whether `emptyStore` was called before measuring. */
  emptiedStore: boolean;
  probeMs: number;
}

interface MallocModule {
  HEAPU8?: Uint8Array;
  _wasm_malloc?: (size: number) => number;
  _wasm_free?: (ptr: number) => void;
}

const CHUNKS = [16 * 2 ** 20, 2 ** 20, 64 * 2 ** 10];

/** Measures the WASM heap in use. If `emptyStore` is true, the MuPDF resource cache is cleared first. null if it cannot be measured. */
export function probeWasmHeap(options: { emptyStore?: boolean } = {}): WasmHeapProbe | null {
  const m = libmupdfModule as MallocModule;
  if (!m.HEAPU8 || !m._wasm_malloc || !m._wasm_free) return null;
  const t0 = performance.now();
  if (options.emptyStore) mupdf.emptyStore();
  const proto = WebAssembly.Memory.prototype;
  const grow = proto.grow;
  // emscripten catches the growth failure and turns it into a malloc failure (linear memory stays as is).
  proto.grow = function (): number {
    throw new RangeError('probeWasmHeap: 선형 메모리 확장 금지');
  };
  const pointers: number[] = [];
  let free = 0;
  try {
    for (const size of CHUNKS) {
      for (;;) {
        let ptr = 0;
        try {
          ptr = m._wasm_malloc(size);
        } catch {
          ptr = 0;
        }
        if (!ptr) break;
        pointers.push(ptr);
        free += size;
      }
    }
  } finally {
    for (const ptr of pointers) m._wasm_free(ptr);
    proto.grow = grow;
  }
  const linear = m.HEAPU8.byteLength;
  return {
    linearBytes: linear,
    freeBytes: free,
    usedBytes: linear - free,
    emptiedStore: options.emptyStore === true,
    probeMs: performance.now() - t0,
  };
}

/** Bench RPCs the extension Worker adds in dev builds (third argument of `exposePdfWorker`). */
export interface BenchWorkerExtras {
  benchProbeHeap(options?: { emptyStore?: boolean }): Promise<WasmHeapProbe | null>;
}
