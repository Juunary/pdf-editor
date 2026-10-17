// 첫 import 유지: mupdf 초기화 전에 Module 설정 객체를 등록한다.
export { wasmHeapBytes, libmupdfModule, type LibMupdfModuleConfig } from './wasm-module.js';
export { openPdf } from './open.js';
