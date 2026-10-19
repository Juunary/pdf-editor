import { defineConfig } from 'vitest/config';

// V6 시험은 4 MB 폴백 폰트를 MuPDF·harfbuzz 로 읽어 turbo 동시 실행 부하에서 기본 5초를 넘을 수 있다.
export default defineConfig({ test: { testTimeout: 30_000 } });
