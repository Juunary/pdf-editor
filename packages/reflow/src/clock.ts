/** Elapsed-time measurement (ms). The build lib (ES2023) has no DOM declarations, so it is accessed via globalThis (provided by Node, browsers and Workers alike). */
export const now = (): number =>
  (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();
