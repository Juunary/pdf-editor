import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// core 를 mupdf 보다 먼저 import 한다(src/spike.ts 참고).
import { runIncrementalControls, runSpike, SEARCH_TERMS, type SpikeResult } from '../src/spike.js';
import { buildSamplePdf } from '../src/fixture.js';

const asset = (p: string) => fileURLToPath(new URL(`../../../assets/fonts/${p}`, import.meta.url));
const TTF = asset('NotoSansKR-Regular-subset.ttf');
const OTF = asset('src/NotoSansKR-Regular.otf');

function spike(fontPath: string): SpikeResult {
  return runSpike({
    sampleBytes: buildSamplePdf(),
    expectedBytes: buildSamplePdf({ includeTarget: false }),
    fontBytes: new Uint8Array(readFileSync(fontPath)),
    fontName: 'NotoSansKR',
  });
}

describe('M0 스파이크: 문단 교체 + 한글 폴백 폰트 임베딩(TTF)', () => {
  const r = spike(TTF);

  it('redaction 은 대상 문단 텍스트만 지우고 배경·괘선·이미지·인접 텍스트를 보존', () => {
    expect(r.redaction.targetTextBefore).toBe(true);
    expect(r.redaction.targetTextAfter).toBe(false);
    expect(r.redaction.diffVsExpectedPx).toBe(0);
    expect(r.redaction.diffOutsideRectPx).toBe(0);
    expect(r.redaction.preexistingRedactAnnots).toBe(0);
  });

  it('redaction 후 canBeSavedIncrementally=false → 전체 저장', () => {
    expect(r.canBeSavedIncrementally).toEqual({
      afterOpen: true,
      afterRedaction: false,
      afterContent: false,
    });
    expect(r.save.method).toBe('full');
  });

  it('폴백 폰트에 모든 글자가 있고 영역을 넘지 않는다', () => {
    expect(r.layout.missing).toEqual([]);
    expect(r.layout.overflow).toBe(false);
  });

  it('저장 전·재열기 렌더가 폰트 파일 직접 렌더(참조)와 픽셀 일치', () => {
    expect(r.preSave.referenceInkPx).toBeGreaterThan(1000);
    expect(r.preSave.diffVsReferencePx).toBe(0);
    expect(r.reopen.diffVsReferencePx).toBe(0);
  });

  it('재열기 후 텍스트 추출·검색(ToUnicode)', () => {
    expect(r.reopen.textFound).toBe(true);
    expect(r.reopen.removedTextAbsent).toBe(true);
    expect(r.reopen.keptTextsPresent).toBe(true);
    for (const term of SEARCH_TERMS) expect(r.reopen.searchHits[term]).toBeGreaterThan(0);
  });

  it('폰트가 Type0/CIDFontType2 + FontFile2 로 서브셋 임베딩되고 ToUnicode 가 있다', () => {
    expect(r.reopen.font).toMatchObject({
      subtype: 'Type0',
      descendantSubtype: 'CIDFontType2',
      fontFileKey: 'FontFile2',
      subsetTagged: true,
      hasToUnicode: true,
    });
    expect(r.reopen.font!.fontFileBytes!).toBeLessThan(500_000);
  });
});

describe('증분 저장 대조', () => {
  const c = runIncrementalControls(buildSamplePdf());

  it('주석만 바꾸면 증분 저장', () => {
    expect(c.annotationOnly.canBeSavedIncrementally).toBe(true);
    expect(c.annotationOnly.decided).toBe('incremental');
    expect(c.annotationOnly.ok).toBe(true);
  });

  it('redaction 후 MuPDF 는 증분 저장을 거부하지 않으며, 출력 앞부분이 원본 그대로다', () => {
    // canBeSavedIncrementally() 는 권고값이다. 저장 방식은 decideSaveMethod 가 강제해야 한다.
    expect(c.afterRedaction.canBeSavedIncrementally).toBe(false);
    expect(c.afterRedaction.ok).toBe(true);
    expect(c.afterRedaction.prefixIsOriginal).toBe(true);
  });
});

describe.skipIf(!existsSync(OTF))('대조: CFF OTF 폴백 폰트(MuPDF 1.28.1 알려진 실패)', () => {
  it('재열기 렌더가 참조와 크게 다르고 서브셋되지 않는다', () => {
    // 원본 OTF 는 git 에 없다(assets/fonts/src). skipIf 여도 describe 본문은 수집 시 실행되므로
    // 파일 읽기는 테스트 안에서 한다.
    const r = spike(OTF);
    // 이 테스트가 실패하면 MuPDF 동작이 바뀐 것이다 → CFF 경로 재평가.
    expect(r.reopen.diffVsReferencePx).toBeGreaterThan(1000);
    expect(r.reopen.font?.subsetTagged).toBe(false);
    expect(r.reopen.font?.descendantSubtype).toBe('CIDFontType0');
  });
});
