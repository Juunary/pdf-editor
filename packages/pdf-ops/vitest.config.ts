import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// MuPDF WASM 테스트(redaction·퍼징)는 turbo 동시 실행 부하에서 기본 5초를 넘을 수 있다.
// M3 문단 편집 테스트는 실제 PageModel·PageLayout 이 필요해 core 추출·layout-recon 원본을 테스트에서만 별칭으로
// 불러온다(패키지 의존성 아님). 빌드 순서와 무관하도록 pdf-ops 도 원본(src)으로 맞춘다.
export default defineConfig({
  test: { testTimeout: 30_000 },
  resolve: {
    alias: [
      { find: /^@pdf-editor\/pdf-ops$/, replacement: here('./src/index.ts') },
      { find: /^@pdf-editor\/layout-recon$/, replacement: here('../layout-recon/src/index.ts') },
      { find: /^@pdf-editor-test\/core-extract$/, replacement: here('../core/src/extract.ts') },
    ],
  },
});
