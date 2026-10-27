/**
 * MuPDF WASM (emscripten) Module settings object.
 *
 * `mupdf` reads `globalThis.$libmupdf_wasm_Module` at import time to initialize, and updates
 * `HEAPU8` on the same object. This module must be evaluated before `mupdf`, so it is the
 * first import of the core entry point. If the Worker needs to change the wasm path, put `locateFile` in before importing core.
 */
export interface LibMupdfModuleConfig {
  locateFile?: (path: string, prefix: string) => string;
  /** Filled in by emscripten. Read for measurement only. */
  HEAPU8?: Uint8Array;
}

const g = globalThis as { $libmupdf_wasm_Module?: LibMupdfModuleConfig };
g.$libmupdf_wasm_Module ??= {};

export const libmupdfModule: LibMupdfModuleConfig = g.$libmupdf_wasm_Module;

/**
 * Current WASM linear memory size (bytes). Linear memory never shrinks, so this equals the maximum so far.
 * null if `mupdf` was initialized before this module and the settings object was not connected.
 */
export function wasmHeapBytes(): number | null {
  return libmupdfModule.HEAPU8?.byteLength ?? null;
}
