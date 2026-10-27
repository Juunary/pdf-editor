import { describe, expect, it } from 'vitest';
import { buildSourceMapImpl } from '../src/content-interp.js';
import { deliveryTrace } from './helpers/device-log.js';
import { FUZZ_SEEDS, randomDoc } from './helpers/fuzz-content.js';

/**
 * Regression test: interpreter delivery sequence = MuPDF Device delivery sequence (docs/m1-pdf-ops.md 5.3).
 * For each fixed-seed random content (helpers/fuzz-content.ts), compares text arrivals (kind, glyph count) and paint order.
 * The comparison is policy-independent (numbers are a function of this sequence). The only known mismatch is the tile-count check for tiling-pattern colored text (R2).
 */
const KNOWN_R2 = [44, 132, 288, 390];

describe('delivery sequence fuzzing', () => {
  it(`fixed seed, ${FUZZ_SEEDS} pages: everything matches except the known R2`, () => {
    const mismatched: number[] = [];
    let aborted = 0;
    for (let seed = 1; seed <= FUZZ_SEEDS; seed++) {
      const doc = randomDoc(seed);
      const trace: string[] = [];
      const map = buildSourceMapImpl(doc, 0, 8, 'first-arrival', trace);
      let dev: string[];
      try {
        dev = deliveryTrace(doc.loadPage(0));
      } catch (e) {
        // MuPDF: a cm while accumulating clip text is a page-interpretation exception. The interpreter also stops at the same point.
        expect(String(e)).toMatch('CTM CHANGE IN CLIP TEXT');
        expect(map.errors.map((x) => x.message)).toContain(
          'MuPDF: 클립 텍스트 누적 중 cm(해석 중단)',
        );
        aborted++;
        continue;
      }
      const interp = trace.map((t) => t.replace(/:[NR]+$/, ''));
      if (interp.join(' ') !== dev.join(' ')) mismatched.push(seed);
    }
    expect(mismatched).toEqual(KNOWN_R2);
    expect(aborted).toBeGreaterThan(0);
  }, 60_000);
});
