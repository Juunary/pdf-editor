import { defineConfig } from 'vitest/config';

// The V6 tests read a 4 MB fallback font with MuPDF and harfbuzz, and under concurrent turbo load they can exceed the default 5 seconds.
export default defineConfig({ test: { testTimeout: 30_000 } });
