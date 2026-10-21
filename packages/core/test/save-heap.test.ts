// M5 S1 저장 힙 모델(docs/m5-heap.md): 문서 통계·저널 보유 추정·planSave 입력.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PdfSession, wasmHeapBytes } from '../src/index.js';
import { computeDocumentStats, objectStreamNumbers, openPdf } from '../src/open.js';
import * as mupdf from 'mupdf';
import { buildPdf } from './pdf-fixtures.js';
import { editParagraph, harness } from './edit-harness.js';

/** 이미지 스트림 2개(원 길이를 아는 값)와 객체 스트림 구조로 저장한 PDF. */
function statsPdf(objstms: boolean): { bytes: Uint8Array; streamBytes: number[] } {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  const a = new Uint8Array(1000).fill(7);
  const b = new Uint8Array(333).fill(9);
  doc.addStream(a, {});
  doc.addStream(b, {});
  doc.insertPage(
    -1,
    doc.addPage([0, 0, 200, 100], 0, { Font: { F1: font } }, 'BT /F1 12 Tf 10 50 Td (s) Tj ET'),
  );
  const buffer = doc.saveToBuffer(objstms ? 'objstms' : '');
  const bytes = buffer.asUint8Array().slice();
  buffer.destroy();
  doc.destroy();
  return { bytes, streamBytes: [a.length, b.length] };
}

describe('computeDocumentStats(D5)', () => {
  it('객체 수·스트림 수·원 스트림 /Length 합을 전수로 센다(디코드 없음)', () => {
    const { bytes } = statsPdf(false);
    const doc = openPdf(bytes, { inputMode: 'stream' });
    const stats = computeDocumentStats(doc);
    let streams = 0;
    let length = 0;
    for (let n = 1; n < doc.countObjects(); n++) {
      const o = doc.newIndirect(n);
      if (o.isStream()) {
        streams++;
        length += o.get('Length').asNumber();
      }
    }
    expect(stats).toEqual({
      objectCount: doc.countObjects(),
      streamCount: streams,
      rawStreamBytes: length,
      objectStreamBytes: 0,
      approximate: false,
    });
    expect(streams).toBeGreaterThanOrEqual(3);
    expect(length).toBeGreaterThanOrEqual(1333);
    doc.destroy();
  });

  it('객체 스트림은 푼 크기를 objectStreamBytes 로 더한다', () => {
    const doc = openPdf(statsPdf(true).bytes, { inputMode: 'stream' });
    const stats = computeDocumentStats(doc);
    let decoded = 0;
    for (let n = 1; n < doc.countObjects(); n++) {
      const o = doc.newIndirect(n);
      if (o.isStream() && o.get('Type').asName() === 'ObjStm')
        decoded += o.readStream().getLength();
    }
    expect(decoded).toBeGreaterThan(0);
    expect(stats.objectStreamBytes).toBe(decoded);
    doc.destroy();
  });

  it('시험 표본으로 본 예상 시간이 예산을 넘으면 층화 표본으로 환산한다(approximate)', () => {
    const pages = Array.from({ length: 600 }, (_, i) => `BT /F1 9 Tf 10 50 Td (p${i}) Tj ET`);
    const bytes = buildPdf(pages);
    const doc = openPdf(bytes, { inputMode: 'stream' });
    const exact = computeDocumentStats(doc);
    // 부를 때마다 1 ms 가는 시계: 시험 표본(64 간격)의 객체당 시간이 커서 전수 예상이 예산을 넘는다.
    let t = 0;
    const approx = computeDocumentStats(doc, { budgetMs: 0.5, now: () => (t += 1), bytes });
    expect(approx.approximate).toBe(true);
    expect(approx.objectCount).toBe(exact.objectCount);
    // 표본 값 × 간격: 마지막 표본이 남은 수만큼만 세므로 스트림 수는 객체 수를 넘지 않는다.
    expect(approx.streamCount).toBeLessThanOrEqual(exact.objectCount);
    expect(approx.streamCount).toBeGreaterThan(0);
    // 쪽마다 같은 배치(쪽·콘텐츠)가 반복되는 문서에서도 한 종류를 통째로 놓치지 않는다(구간 첫 객체만 고르면 놓친다).
    // 바이트 합은 큰 스트림 몇 개(여기서는 폰트 파일)를 놓치면 크게 틀린다(표본의 한계, docs/m5-heap.md 2.4).
    expect(Math.abs(approx.streamCount - exact.streamCount) / exact.streamCount).toBeLessThan(0.35);
    // 예산이 넉넉하면 전수.
    expect(computeDocumentStats(doc, { budgetMs: 1e9 })).toEqual(exact);
    // 원본 바이트가 없으면 객체 스트림 번호를 모르므로 예산을 넘어도 전수(M1).
    t = 0;
    expect(computeDocumentStats(doc, { budgetMs: 0.5, now: () => (t += 1) })).toEqual(exact);
    doc.destroy();
  });

  it('표본이어도 객체 스트림 푼 크기는 xref 에서 찾은 객체 스트림 전수 값이다(M1)', () => {
    // 객체 600쪽 분량을 객체 스트림으로 저장: 압축 객체가 대부분이고 객체 스트림은 드물다.
    const src = openPdf(
      buildPdf(Array.from({ length: 600 }, (_, i) => `BT /F1 9 Tf 10 50 Td (p${i}) Tj ET`)),
      { inputMode: 'buffer' },
    );
    const saved = src.saveToBuffer('objstms');
    const bytes = saved.asUint8Array().slice();
    saved.destroy();
    src.destroy();
    const doc = openPdf(bytes, { inputMode: 'stream' });
    const exact = computeDocumentStats(doc);
    expect(exact.objectStreamBytes).toBeGreaterThan(0);
    const numbers = objectStreamNumbers(doc, bytes);
    expect(numbers?.size).toBeGreaterThan(0);
    let t = 0;
    const approx = computeDocumentStats(doc, { budgetMs: 0.5, now: () => (t += 1), bytes });
    expect(approx.approximate).toBe(true);
    expect(approx.objectStreamBytes).toBe(exact.objectStreamBytes);
    doc.destroy();
  });

  it('xref 를 읽지 못하면 객체 스트림 번호는 null, 전통 표만 있으면 빈 집합', () => {
    const bytes = buildPdf(['BT /F1 9 Tf 10 50 Td (a) Tj ET']);
    const doc = openPdf(bytes, { inputMode: 'stream' });
    expect(objectStreamNumbers(doc, bytes)).toEqual(new Set());
    expect(objectStreamNumbers(doc, new Uint8Array(10))).toBeNull();
    const shifted = new Uint8Array(bytes.length + 7);
    shifted.set(new TextEncoder().encode('garbage'), 0);
    shifted.set(bytes, 7);
    expect(objectStreamNumbers(doc, shifted)).toBeNull();
    doc.destroy();
  });
});

describe('PdfSession 저장 힙 입력', () => {
  afterEach(() => vi.useRealTimers());

  it('첫 쪽 전체 렌더 뒤 통계 계산을 한 번 예약하고, 닫으면 취소한다', () => {
    vi.useFakeTimers();
    const s = new PdfSession();
    s.open(buildPdf(['BT /F1 12 Tf 10 50 Td (a) Tj ET']));
    expect(vi.getTimerCount()).toBe(0);
    s.renderPage({ pageIndex: 0, scale: 1 });
    s.renderPage({ pageIndex: 0, scale: 1 });
    expect(vi.getTimerCount()).toBe(1);
    vi.runAllTimers();
    const stats = s.documentStats();
    expect(s.documentStats()).toBe(stats);
    s.renderPage({ pageIndex: 0, scale: 1 });
    expect(vi.getTimerCount()).toBe(0);
    s.close();
    const t = new PdfSession();
    t.open(buildPdf(['BT /F1 12 Tf 10 50 Td (a) Tj ET']));
    t.renderPage({ pageIndex: 0, scale: 1 });
    t.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('저널 보유 추정: 커밋마다 쪽 콘텐츠 /Length 를 더하고, undo 는 유지, redo 를 버리는 새 편집은 그만큼 뺀다', async () => {
    const { s } = harness();
    expect(s.planSave({ changes: [] }).heap.journalBytes).toBe(0);
    await editParagraph(s, 1, 'first edit');
    const one = s.planSave({ changes: [] }).heap.journalBytes!;
    expect(one).toBeGreaterThan(0);
    await editParagraph(s, 1, 'second edit');
    const two = s.planSave({ changes: [] }).heap.journalBytes!;
    expect(two).toBeGreaterThan(one);
    await s.undo();
    expect(s.planSave({ changes: [] }).heap.journalBytes).toBe(two);
    // undo 뒤 새 편집: redo 단계(두 번째 편집)가 사라진다.
    await editParagraph(s, 1, 'third edit');
    const three = s.planSave({ changes: [] }).heap.journalBytes!;
    expect(three).toBeLessThan(two + (two - one));
    expect(s.journalAdvice()).toMatchObject({ advised: false, journalBytes: three });
    s.close();
  });

  it('저장 뒤 판정은 저장이 쓰고 놓은 힙을 사용 중으로 세지 않는다(H1)', () => {
    const s = new PdfSession();
    s.open(buildPdf(['BT /F1 12 Tf 10 50 Td (a) Tj ET']));
    const first = s.planSave({ changes: ['content-stream'] }).heap;
    expect(first.priorSavePeakBytes).toBeUndefined();
    expect(first.usedHeapBytes).toBe(wasmHeapBytes());
    const saved = s.save({ changes: ['content-stream'] });
    const second = s.planSave({ changes: ['content-stream'] }).heap;
    expect(second.priorSavePeakBytes).toBe(saved.wasmHeapBytes);
    // 저장 뒤 힙이 늘지 않았으면 사용 중 추정은 첫 저장 때 값 그대로다.
    const grown = Math.max(0, wasmHeapBytes()! - saved.wasmHeapBytes!);
    expect(second.usedHeapBytes).toBe(first.usedHeapBytes! + grown);
    // 다시 열면 기록을 지운다.
    s.open(buildPdf(['BT /F1 12 Tf 10 50 Td (b) Tj ET']));
    expect(s.planSave({ changes: [] }).heap.priorSavePeakBytes).toBeUndefined();
    s.close();
  });
});
