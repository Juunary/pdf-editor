/**
 * MuPDF WASM(emscripten) Module 설정 객체.
 *
 * `mupdf` 는 import 시점에 `globalThis.$libmupdf_wasm_Module` 을 읽어 초기화하고, 같은 객체에
 * `HEAPU8` 를 갱신한다. 이 모듈은 반드시 `mupdf` 보다 먼저 평가되어야 하므로 core 진입점의
 * 첫 import 로 둔다. Worker 에서 wasm 경로를 바꿔야 하면 core import 전에 `locateFile` 을 넣는다.
 */
export interface LibMupdfModuleConfig {
  locateFile?: (path: string, prefix: string) => string;
  /** emscripten 이 채운다. 측정 전용으로만 읽는다. */
  HEAPU8?: Uint8Array;
}

const g = globalThis as { $libmupdf_wasm_Module?: LibMupdfModuleConfig };
g.$libmupdf_wasm_Module ??= {};

export const libmupdfModule: LibMupdfModuleConfig = g.$libmupdf_wasm_Module;

/**
 * 현재 WASM 선형 메모리 크기(byte). 선형 메모리는 줄지 않으므로 지금까지의 최대치와 같다.
 * `mupdf` 가 이 모듈보다 먼저 초기화되어 설정 객체가 연결되지 않았으면 null.
 */
export function wasmHeapBytes(): number | null {
  return libmupdfModule.HEAPU8?.byteLength ?? null;
}
