import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 정확도 하네스·복원 시험이 빌드 산출물(dist)이 아니라 커밋된 layout-recon 소스로 돌게 한다
// (dist 가 낡으면 보고 수치가 코드와 달라진다, M2 리뷰 M4).
export default defineConfig({
  resolve: {
    alias: {
      '@pdf-editor/layout-recon': fileURLToPath(
        new URL('../layout-recon/src/index.ts', import.meta.url),
      ),
    },
  },
});
