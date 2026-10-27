import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Make the accuracy harness and recovery tests run on the committed layout-recon source rather than the build output (dist)
// (a stale dist makes reported numbers differ from the code, M2 review M4).
export default defineConfig({
  resolve: {
    alias: {
      '@pdf-editor/layout-recon': fileURLToPath(
        new URL('../layout-recon/src/index.ts', import.meta.url),
      ),
    },
  },
});
