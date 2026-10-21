/**
 * 벤치 전용 WASM 힙 측정(계약 D1·4.1 사용자 결정 2026-10-21, docs/m5-followup.md). 스토어 빌드에 넣지 않는다:
 * 확장의 Worker 진입점이 dev 빌드에서만 이 모듈을 동적 import 해 `benchProbeHeap` RPC 로 노출한다.
 *
 * WASM 선형 메모리는 줄지 않으므로 MuPDF 캐시를 비운(`emptyStore`) 뒤의 값은 선형 메모리 크기가 아니라 "사용 중 힙"으로
 * 잰다: 선형 메모리 확장을 막은 채 `_wasm_malloc` 으로 빈 공간을 큰 조각부터(16 MiB → 1 MiB → 64 KiB) 받아 보고 모두
 * 돌려준다. 사용 중 = 선형 메모리 − 받은 합. 64 KiB 보다 작은 빈 조각은 사용 중으로 센다(과대 쪽 오차).
 * MuPDF 의 malloc 은 실패하면 자원 캐시를 비워(scavenge) 다시 시도하므로, 이 측정은 캐시를 비운 상태의 값이 된다.
 */
import './wasm-module.js';
import * as mupdf from 'mupdf';
import { libmupdfModule } from './wasm-module.js';

export interface WasmHeapProbe {
  /** 선형 메모리 크기(byte, 줄지 않는 최대치). 측정이 선형 메모리를 늘리지 않는다. */
  linearBytes: number;
  /** 받아 본 빈 공간 합(byte). */
  freeBytes: number;
  /** linearBytes − freeBytes. */
  usedBytes: number;
  /** 측정 전에 `emptyStore` 를 불렀는지. */
  emptiedStore: boolean;
  probeMs: number;
}

interface MallocModule {
  HEAPU8?: Uint8Array;
  _wasm_malloc?: (size: number) => number;
  _wasm_free?: (ptr: number) => void;
}

const CHUNKS = [16 * 2 ** 20, 2 ** 20, 64 * 2 ** 10];

/** 사용 중 WASM 힙을 잰다. `emptyStore` 가 true 면 먼저 MuPDF 자원 캐시를 비운다. 측정할 수 없으면 null. */
export function probeWasmHeap(options: { emptyStore?: boolean } = {}): WasmHeapProbe | null {
  const m = libmupdfModule as MallocModule;
  if (!m.HEAPU8 || !m._wasm_malloc || !m._wasm_free) return null;
  const t0 = performance.now();
  if (options.emptyStore) mupdf.emptyStore();
  const proto = WebAssembly.Memory.prototype;
  const grow = proto.grow;
  // 확장 실패는 emscripten 이 잡아 malloc 실패로 바꾼다(선형 메모리는 그대로).
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

/** 확장 Worker 가 dev 빌드에서 더하는 벤치 RPC(`exposePdfWorker` 세 번째 인자). */
export interface BenchWorkerExtras {
  benchProbeHeap(options?: { emptyStore?: boolean }): Promise<WasmHeapProbe | null>;
}
