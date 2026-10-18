import { describe, expect, it } from 'vitest';
import type { PageModel, SourceMap } from '@pdf-editor/shared-types';
import { linkPage } from '../src/index.js';
import { buildSourceMapImpl, type GlyphSeqPolicy } from '../src/content-interp.js';
import { deliveryTrace } from './helpers/device-log.js';
import { FUZZ_SEEDS, randomDoc } from './helpers/fuzz-content.js';
import { buildTestPageModel, type HelperPolicy } from './helpers/page-model.js';

/**
 * glyphSeq 정책 측정(docs/m1-pdf-ops.md 4절). 같은 시드 퍼징 문서에서 테스트 전용 PageModel(core 쪽 판정)과
 * SourceMap 을 매칭해 실패 쪽 수를 센다. 실패 = 총수 차이 또는 소유 번호 글자·도형 미매칭.
 * 글리프 단위로는 인터프리터가 아는 실제 첫 도착(N)·재전송(R)과 core 쪽 판정을 같은 전달 순서에서 비교한다.
 * - 가짜 재전송: 판정 R, 실제 N. 키(폰트, gid, trm, ctm)가 같은 다른 글리프가 센 목록에 있었다는 뜻이다(구조적 한계).
 * - 놓친 재전송: 판정 N, 실제 R.
 * 측정값은 고정 시드라 결정적이며, 바뀌면 원인을 확인하고 문서와 함께 고친다.
 */

interface Row {
  failedPages: number[];
  falseResend: number;
  missedResend: number;
  /** 실패 쪽 원인: R2(전달 순서 자체가 다름), 가짜 재전송 있음, 놓친 재전송만 있음, 그 밖. */
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
      continue; // MuPDF 페이지 해석 예외(R10)
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
      continue; // 전달 순서 자체가 다른 쪽(R2)은 글리프 비교 제외
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

describe('glyphSeq 정책 측정(퍼징)', () => {
  it('정책별 실패 쪽·가짜/놓친 재전송', () => {
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
