import { defineConfig } from 'vitest/config';

// MuPDF WASM 테스트(redaction·퍼징)는 turbo 동시 실행 부하에서 기본 5초를 넘을 수 있다.
export default defineConfig({ test: { testTimeout: 30_000 } });
