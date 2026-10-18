import { describe, expect, it } from 'vitest';
import { buildSourceMapImpl } from '../src/content-interp.js';
import { deliveryTrace } from './helpers/device-log.js';
import { FUZZ_SEEDS, randomDoc } from './helpers/fuzz-content.js';

/**
 * 인터프리터 전달 순서열 = MuPDF Device 전달 순서열 회귀 테스트(docs/m1-pdf-ops.md 5.3).
 * 고정 시드 무작위 콘텐츠(helpers/fuzz-content.ts)마다 텍스트 도착(종류·글리프 수)과 칠하기 순서를 비교한다.
 * 정책과 무관한 비교다(번호는 이 순서열의 함수). 알려진 불일치는 타일링 패턴 색 텍스트의 타일 수 판정(R2)뿐이다.
 */
const KNOWN_R2 = [44, 132, 288, 390];

describe('전달 순서열 퍼징', () => {
  it(`고정 시드 ${FUZZ_SEEDS}쪽: 알려진 R2 외 전부 일치`, () => {
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
        // MuPDF: 클립 텍스트 누적 중 cm 은 페이지 해석 예외. 인터프리터도 같은 지점에서 멈춘다.
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
