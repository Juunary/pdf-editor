/** Elapsed-time measurement (ms). The build lib (ES2023) has no DOM declarations, so it goes through globalThis (available in Node, browsers and Workers). */
export const now = (): number =>
  (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();
