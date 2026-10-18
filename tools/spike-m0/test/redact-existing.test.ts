import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// core 를 mupdf 보다 먼저 import 한다(src/redact-spike.ts 참고).
import { runRedactCase, LINK_URI } from '../src/redact-spike.js';

const TTF = fileURLToPath(
  new URL('../../../assets/fonts/NotoSansKR-Regular-subset.ttf', import.meta.url),
);
const fontBytes = new Uint8Array(readFileSync(TTF));

describe('기존 Redact 주석이 있는 문서의 편집', () => {
  it('편집 전 보고: 문서 3개(1쪽 2·2쪽 1), 편집 영역과 겹침 R2, 링크 1개 제거 예정 → warn', () => {
    const r = runRedactCase('per-annotation', fontBytes);
    expect(r.reportBefore).toEqual({ total: 3, pages: [0, 1] });
    expect(r.impact).toMatchObject({
      preexisting: 2,
      overlapping: ['R2'],
      linksRemoved: [LINK_URI],
      level: 'warn',
    });
  });

  it('편집 경로(주석 단위): 새 redaction 만 적용, 기존 주석·그 아래 텍스트는 저장 후에도 그대로', () => {
    const r = runRedactCase('per-annotation', fontBytes);
    expect(r.afterEdit).toMatchObject({
      redactAnnots: [2, 1],
      existingObjectsUnchanged: true,
      changedObjects: ['page1'],
      adjacentTextPresent: true,
      targetTextPresent: false,
      newTextFound: true,
      notePresent: true,
      links: 0,
    });
    expect(r.render).toEqual({ page1OutsideTargetPx: 0, page2VsOriginalPx: 0 });
    expect(r.save.method).toBe('full');
    expect(r.reopen).toMatchObject({
      redactAnnots: [2, 1],
      reportSame: true,
      existingTreesSame: [true, true, true],
      adjacentTextPresent: true,
      newTextFound: true,
      page1OutsideTargetPx: 0,
      page2VsOriginalPx: 0,
    });
    expect(r.mupdfMessages).toEqual([]);
  });

  it('대조: 페이지 단위 applyRedactions 는 기존 주석(R1·R2)을 적용해 인접 문단까지 지운다', () => {
    const r = runRedactCase('page-level', fontBytes);
    expect(r.afterEdit.redactAnnots).toEqual([0, 1]);
    expect(r.afterEdit.adjacentTextPresent).toBe(false);
    expect(r.render.page1OutsideTargetPx).toBeGreaterThan(1000);
  });

  it('정책 "임시 분리": 페이지 단위 redaction 을 써도 기존 주석과 그 아래 텍스트가 남는다', () => {
    const r = runRedactCase('detach', fontBytes);
    expect(r.afterEdit).toMatchObject({
      redactAnnots: [2, 1],
      existingObjectsUnchanged: true,
      adjacentTextPresent: true,
      targetTextPresent: false,
    });
    expect(r.render).toEqual({ page1OutsideTargetPx: 0, page2VsOriginalPx: 0 });
    expect(r.reopen.reportSame).toBe(true);
  });
});
