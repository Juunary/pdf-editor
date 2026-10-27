import { defineConfig } from 'vitest/config';

// Unit tests only. Playwright runs e2e/*.spec.ts.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
    __BUILD_KIND__: JSON.stringify('dev'),
    __SOURCE_URL__: JSON.stringify('https://example.invalid/tree/v0.0.0-test'),
  },
  test: { include: ['test/**/*.test.ts'] },
});
