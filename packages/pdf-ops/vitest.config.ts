import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// MuPDF WASM tests (redaction, fuzzing) can exceed the default 5 s under turbo's concurrent-run load.
// The M3 paragraph-edit tests need a real PageModel and PageLayout, so the core extraction and layout-recon sources are
// aliased in for tests only (not a package dependency). pdf-ops is also pointed at its sources (src) so build order does not matter.
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
