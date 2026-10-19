/** 경과 시간 측정(ms). 빌드 lib(ES2023)에 DOM 선언이 없어 globalThis 로 접근한다(Node·브라우저·Worker 모두 제공). */
export const now = (): number =>
  (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();
