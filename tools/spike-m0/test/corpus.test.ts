import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// core 를 mupdf 보다 먼저 import 한다(src/corpus-edit.ts 참고).
import { analyzeForEdit } from '../src/corpus-cli.js';
import { judgeRestrictions, runCorpusEdit, type ParagraphContext } from '../src/corpus-edit.js';
import { rectsIntersect, scanSegments } from '../src/corpus-select.js';
import { TARGET_RECT } from '../src/fixture.js';
import { m0FixturePairs, runPdfjsCheck } from '../src/pdfjs-check.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../../../fixtures/m0/${name}`, import.meta.url))),
  );
const fontBytes = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL('../../../assets/fonts/NotoSansKR-Regular-subset.ttf', import.meta.url)),
  ),
);

describe('코퍼스 문단 자동 선택(stext)', () => {
  it('m0-sample: Day 1 하드코딩 대상 문단을 자동으로 고르고, 인접 문단과 겹치지 않는다', () => {
    const r = analyzeForEdit(fixture('m0-sample.pdf'));
    expect(r.paragraphs).toHaveLength(1);
    const p = r.paragraphs[0]!;
    expect(p.lines.map((l) => l.text).join(' ')).toContain(
      'This paragraph is the replacement target.',
    );
    expect(p.fontSize).toBe(11);
    expect(p.linePitch).toBeCloseTo(14, 1);
    // 자동 영역은 Day 1 하드코딩 영역 안에 있다
    expect(p.rect[0]).toBeGreaterThanOrEqual(TARGET_RECT[0]);
    expect(p.rect[1]).toBeGreaterThanOrEqual(TARGET_RECT[1]);
    expect(p.rect[3]).toBeLessThanOrEqual(TARGET_RECT[3]);
    expect(r.selection.rejected['too-few-lines']).toBe(3);
    expect(r.analysis.forms.usages).toBe(0);
  });

  it('공유 XObject 픽스처: Form 안 텍스트 문단은 Form 문맥(L 조건 입력)과 함께 보고된다', () => {
    const r = analyzeForEdit(fixture('m0-shared-xobject.pdf'));
    expect(r.analysis.forms.shared).toBe(2);
    expect(r.analysis.forms.sharedWithText).toBe(2);
    for (const p of r.paragraphs) {
      expect(p.formUsagesOnPage).toBeGreaterThan(0);
      expect(p.textFormsOverlapping.length).toBeGreaterThan(0);
    }
  });

  it('훑기 구간: 15%·50%·85% 지점 + 나머지, 중복 없음', () => {
    const segs = scanSegments(100);
    expect(segs[0]![0]).toBe(14); // floor(99 × 0.15)
    expect(segs[1]![0]).toBe(49);
    expect(segs[2]![0]).toBe(84);
    const all = segs.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(scanSegments(1)).toEqual([[0]]);
  });
});

describe('코퍼스 문단 교체(redaction → 한글 폴백 임베딩 → 전체 저장)', () => {
  it('m0-sample: 실패 0, 편집 영역 밖 0 px, 재열기 검색 적중, 전체 저장·힙 판정 ok', () => {
    const plan = analyzeForEdit(fixture('m0-sample.pdf'));
    const r = runCorpusEdit({
      bytes: fixture('m0-sample.pdf'),
      paragraphs: plan.paragraphs,
      fontBytes,
    });
    const p = r.paragraphs[0]!;
    expect(p.failures).toEqual([]);
    expect(p.redaction.outsidePx).toBe(0);
    expect(p.redaction.neighborLinesLost).toBe(0);
    expect(p.preSave!.vsReferencePx).toBe(0);
    expect(p.layout!.lineCount).toBeLessThanOrEqual(p.lineCount);
    expect(Object.values(p.reopen!.searchHits).every((n) => n >= 1)).toBe(true);
    expect(r.save.method).toBe('full');
    expect(r.save.canBeSavedIncrementally).toEqual({ afterOpen: true, beforeSave: false });
    expect(r.save.heap!.level).toBe('ok');
    expect(r.font).toMatchObject({
      subtype: 'Type0',
      fontFileKey: 'FontFile2',
      hasToUnicode: true,
    });
    expect(r.mupdfMessages.count).toBe(0);
  });

  it('제한 판정: Form L1·L2·L7, 태그 MCID, 매핑 위험 문자', () => {
    const base = analyzeForEdit(fixture('m0-sample.pdf')).paragraphs[0]!;
    const ctx: ParagraphContext = {
      ...base,
      formUsagesOnPage: 2,
      textFormsOverlapping: [
        {
          objectNumber: 9,
          usages: 3,
          depth: 1,
          L1NoResources: true,
          L2StructParents: true,
          L6ParseError: false,
          L7OptionalContent: true,
        },
      ],
      mcidOnPage: 4,
      tagged: true,
      fontMappingRisk: ['X(Type3/-)'],
      unmappedRatio: 0.1,
    };
    const codes = judgeRestrictions(ctx).map((r) => `${r.code}:${r.level}`);
    expect(codes).toEqual([
      'L1:limit',
      'L2:limit',
      'L7:warn',
      'form-instancing:warn',
      'tagged:limit',
      'font-mapping:warn',
      'unmapped-text:limit',
    ]);
  });

  it('rectsIntersect: 면적 있는 교차만', () => {
    expect(rectsIntersect([0, 0, 10, 10], [10, 0, 20, 10])).toBe(false);
    expect(rectsIntersect([0, 0, 10, 10], [9, 9, 20, 20])).toBe(true);
  });
});

describe('pdf.js(pdfjs-dist) 독립 확인', () => {
  it('fixtures/m0 편집 결과 3개: 한글 문단 추출·검색어·편집 영역 밖 0 px', async () => {
    const results = await runPdfjsCheck(
      m0FixturePairs(root),
      fileURLToPath(new URL('../../../out/m0-corpus/pdfjs-test', import.meta.url)),
    );
    for (const r of results) {
      expect(r.error, r.id).toBeUndefined();
      expect(r.ok, r.id).toBe(true);
      for (const p of r.pages) expect(p.inkRatioVsMupdf!, r.id).toBeGreaterThan(0.8);
    }
  }, 60_000);
});
