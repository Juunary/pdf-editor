import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// core 를 mupdf 보다 먼저 import 한다(src/xobject-spike.ts 참고).
import { runXObjectCase, type XObjectCaseResult } from '../src/xobject-spike.js';

const TTF = fileURLToPath(
  new URL('../../../assets/fonts/NotoSansKR-Regular-subset.ttf', import.meta.url),
);
const fontBytes = new Uint8Array(readFileSync(TTF));
const unchangedLabels = ['A', 'A/Fx2', 'C', 'C/Fx2', 'D', 'D/Fx2', 'E(Fx2 직접)'];

function expectOthersUntouched(r: XObjectCaseResult) {
  expect(r.objects.changed).toEqual(['page1']);
  for (const u of r.usagesAfter) {
    expect(u.original, u.label).toBe(unchangedLabels.includes(u.label));
  }
  expect(r.render.page1OutsideSelectedPx).toBe(0);
  expect(r.render.page2VsOriginalPx).toBe(0);
  expect(r.reopen.page2VsOriginalPx).toBe(0);
  expect(r.reopen.page2TextSame).toBe(true);
  expect(r.reopen.page2TreeDecodedSame).toBe(true);
  expect(r.reopen.page2TreeRawSame).toBe(true);
  expect(r.save.method).toBe('full');
}

describe('공유 Form XObject: 선택 사용 위치만 복제 후 수정', () => {
  it('픽스처 공유 구조: Fx1 4곳(1쪽 2 + 2쪽 2), Fx2 5곳(Fx1 안 4 + 2쪽 직접 1)', () => {
    const r = runXObjectCase('depth1', { fontBytes });
    expect(r.usageCountsBefore).toEqual({ Fx1: 4, Fx2: 5 });
  });

  for (const c of ['depth1', 'depth2', 'sequential'] as const) {
    it(`${c}: 대상 텍스트만 교체, 나머지 위치·페이지는 객체·렌더 불변`, () => {
      const r = runXObjectCase(c, { fontBytes });
      expectOthersUntouched(r);
      expect(r.page1Content.afterBytes - r.page1Content.beforeBytes).toBe(1); // /Fx1 → /FxE0|/FxE1
      expect(r.render.afterRemovalVsExpectedPx).toBe(0);
      expect(r.render.referenceInkPx!).toBeGreaterThan(1000);
      expect(r.render.preSaveVsReferencePx).toBe(0);
      expect(r.reopen.page1VsReferencePx).toBe(0);
      expect(r.reopen.newTextFound.every(Boolean)).toBe(true);
      for (const e of r.edits) {
        expect(e.layout).toEqual({
          lineCount: e.layout.lineCount,
          overflow: false,
          missing: [],
          outsideFormBBox: false,
        });
        expect(e.newForms).toBe(2);
      }
      expect(r.mupdfMessages).toEqual([]);
    });
  }

  it('대조: 페이지 redaction 은 같은 페이지의 비선택 위치(A)까지 새 인스턴스로 바꾼다(렌더는 같음)', () => {
    const r = runXObjectCase('mupdf-page-redaction', { fontBytes });
    expect(r.edits[0]!.newForms).toBe(4);
    const a = r.usagesAfter.find((u) => u.label === 'A')!;
    expect(a.original).toBe(false);
    expect(r.usagesAfter.filter((u) => u.original).map((u) => u.label)).toEqual([
      'C',
      'C/Fx2',
      'D',
      'D/Fx2',
      'E(Fx2 직접)',
    ]);
    expect(r.render.afterRemovalVsExpectedPx).toBe(0);
    expect(r.render.page1OutsideSelectedPx).toBe(0);
    expect(r.reopen.page2TreeRawSame).toBe(true);
  });
});
