import { defineConfig } from 'vite';

// MV3 확장 빌드. 출력은 dist/ 이며 Chrome "압축해제된 확장 프로그램 로드" 대상이다.
// - viewer.html: 뷰어(일반 페이지·MIME handler 공용)
// - background.js: 서비스 워커(파일명 고정, manifest 에서 참조)
// - MuPDF WASM: Worker 번들이 `new URL('mupdf-wasm.wasm', import.meta.url)` 로 참조 → 자산으로 출력
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome128',
    // wasm(약 10MB)·폰트를 data URL 로 인라인하지 않는다.
    assetsInlineLimit: 0,
    modulePreload: false,
    sourcemap: true,
    rolldownOptions: {
      input: {
        viewer: 'viewer.html',
        background: 'src/background.ts',
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
      },
    },
  },
  worker: {
    format: 'es',
  },
});
