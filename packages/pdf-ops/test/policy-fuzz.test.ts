import { describe, expect, it } from 'vitest';
import type { PageModel, SourceMap } from '@pdf-editor/shared-types';
import { linkPage } from '../src/index.js';
import { buildSourceMapImpl, type GlyphSeqPolicy } from '../src/content-interp.js';
import { deliveryTrace } from './helpers/device-log.js';
import { FUZZ_SEEDS, randomDoc } from './helpers/fuzz-content.js';
import { buildTestPageModel, type HelperPolicy } from './helpers/page-model.js';

/**
 * glyphSeq policy measurement (docs/m1-pdf-ops.md section 4). On the same-seed fuzz documents, matches the test-only PageModel (core-side classification) with
 * the SourceMap and counts failed pages. Failure = total count difference or an unmatched glyph/shape with an owned number.
 * At the glyph level, compares the actual first arrival (N) and re-send (R) known to the interpreter with the core-side classification on the same delivery sequence.
 * - False re-send: classified R, actually N. It means another glyph with the same key (font, gid, trm, ctm) was in the counted list (structural limit).
 * - Missed re-send: classified N, actually R.
 * The measured values are deterministic because of the fixed seed; if they change, identify the cause and fix it together with the document.
 */

interface Row {
  failedPages: number[];
  falseResend: number;
  missedResend: number;
  /** Cause of a failed page: R2 (the delivery sequence itself differs), has false re-sends, has only missed re-sends, other. */
  causes: { r2: number; falseResend: number; missedOnly: number; other: number };
}

function owned(map: SourceMap, model: PageModel) {
  const g = new Set<number>();
  const p = new Set<number>();
  for (const op of map.ops) {
    op.text?.glyphs.forEach((x) => x.seq !== null && g.add(x.seq));
    op.paintSeq?.forEach((x) => p.add(x));
  }
  return {
    chars: model.chars.filter((c) => g.has(c.glyphSeq)).length,
    paints: [...model.paths, ...model.images, ...model.shades].filter((x) => p.has(x.paintSeq))
      .length,
  };
}

function measure(helper: HelperPolicy, policy: GlyphSeqPolicy): Row {
  const row: Row = {
    failedPages: [],
    falseResend: 0,
    missedResend: 0,
    causes: { r2: 0, falseResend: 0, missedOnly: 0, other: 0 },
  };
  for (let seed = 1; seed <= FUZZ_SEEDS; seed++) {
    const doc = randomDoc(seed);
    let model: PageModel;
    let dev: string[];
    try {
      model = buildTestPageModel(doc, 0, helper);
      dev = deliveryTrace(doc.loadPage(0), true, {
        step1FillStrokeOnly: helper === 'first-arrival-v2',
      });
    } catch {
      continue; // MuPDF page interpretation exception (R10)
    }
    const trace: string[] = [];
    const map = buildSourceMapImpl(doc, 0, 8, policy, trace);
    const { stats } = linkPage(model, map);
    const own = owned(map, model);
    const failed =
      stats.glyphCountDelta !== 0 ||
      stats.paintCountDelta !== 0 ||
      stats.matchedChars !== own.chars ||
      stats.matchedPaints !== own.paints;
    if (failed) row.failedPages.push(seed);
    if (helper === 'no-clip') continue;
    const strip = (a: string[]) => a.map((x) => x.replace(/:[NR]+$/, '')).join(' ');
    if (strip(trace) !== strip(dev)) {
      if (failed) row.causes.r2++;
      continue; // page whose delivery sequence itself differs (R2) is excluded from the glyph comparison
    }
    let falses = 0;
    let missed = 0;
    trace.forEach((t, k) => {
      const a = t.split(':')[2] ?? '';
      const b = dev[k]!.split(':')[2] ?? '';
      for (let q = 0; q < a.length; q++) {
        if (a[q] === 'N' && b[q] === 'R') falses++;
        if (a[q] === 'R' && b[q] === 'N') missed++;
      }
    });
    row.falseResend += falses;
    row.missedResend += missed;
    if (failed) {
      if (falses > 0) row.causes.falseResend++;
      else if (missed > 0) row.causes.missedOnly++;
      else row.causes.other++;
    }
  }
  return row;
}

describe('glyphSeq policy measurement (fuzzing)', () => {
  it('failed pages and false/missed re-sends per policy', () => {
    const firstArrival = measure('first-arrival', 'first-arrival');
    const v2 = measure('first-arrival-v2', 'first-arrival');
    const noClip = measure('no-clip', 'no-clip');
    const view = (r: Row) => ({
      failedPages: r.failedPages.length,
      falseResend: r.falseResend,
      missedResend: r.missedResend,
      causes: r.causes,
    });
    expect({
      firstArrival: view(firstArrival),
      firstArrivalV2: view(v2),
      noClip: noClip.failedPages,
    }).toMatchInlineSnapshot(`
      {
        "firstArrival": {
          "causes": {
            "falseResend": 18,
            "missedOnly": 1,
            "other": 0,
            "r2": 4,
          },
          "failedPages": 23,
          "falseResend": 73,
          "missedResend": 8,
        },
        "firstArrivalV2": {
          "causes": {
            "falseResend": 18,
            "missedOnly": 11,
            "other": 0,
            "r2": 4,
          },
          "failedPages": 33,
          "falseResend": 73,
          "missedResend": 67,
        },
        "noClip": [
          44,
          132,
          288,
          390,
        ],
      }
    `);
  }, 180_000);
});
