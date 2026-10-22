/**
 * 편집 커밋의 스트림 압축(M5 Windows 확인 W2, docs/m5-followup.md 5.1): 편집이 풀린 채 다시 쓴 큰 쪽 콘텐츠를 커밋 직전 Flate 로
 * 압축해, MuPDF 저널이 다음 편집마다 보관하는 이전 판이 풀린 크기가 아니라 압축 크기가 되게 한다.
 * 실제 어댑터로 압축 여부·저널 추정, 결과 동일성(쪽 텍스트·렌더 픽셀·저장 재열기·재적용), 되돌리기, 커밋 중 동시 호출,
 * WASM 사용 중 힙 증가를 본다. 큰 쪽은 주석 줄(렌더·추출에 영향 없음)로 콘텐츠를 키운 합성 문서다.
 */
// 첫 import 유지: mupdf 보다 먼저 WASM Module 설정을 등록해야 힙 측정(저널 추정의 계수 모델·probeWasmHeap)이 연결된다.
import '../src/wasm-module.js';
import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import type { DraftInput, EditOp, ParagraphEditPlan, PathEdit } from '@pdf-editor/shared-types';
import { PdfSession } from '../src/index.js';
import { probeWasmHeap } from '../src/bench-memory.js';
import { FONT_BYTES } from './edit-harness.js';
import { buildDocument } from './pdf-fixtures.js';

const MiB = 2 ** 20;
const LINES = 8;

/** 콘텐츠 스트림 주석처럼 보이는 결정적 줄(작은 좌표 집합이라 실제 콘텐츠처럼 압축이 잘 된다). */
function filler(bytes: number, seed: number): string {
  let x = seed >>> 0;
  const next = () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x;
  };
  const out: string[] = [];
  let size = 0;
  while (size < bytes) {
    const l = `% ${(next() % 48) * 12.5} ${(next() % 64) * 12.5} m ${(next() % 48) * 12.5} ${(next() % 64) * 12.5} l S`;
    out.push(l);
    size += l.length + 1;
  }
  return out.join('\n');
}

/** 한 줄 문단 LINES 개 사이사이에 주석 채움(합계 약 `fillBytes`)과 선 패스 하나가 있는 쪽. 원본은 Flate 압축. */
function heavyPdf(fillBytes: number): Uint8Array {
  const parts: string[] = ['q 1 w 72 80 m 540 80 l S Q'];
  for (let i = 0; i < LINES; i++) {
    parts.push(`BT /F1 11 Tf 72 ${740 - i * 70} Td (Paragraph ${i + 1} original text here.) Tj ET`);
    parts.push(filler(Math.floor(fillBytes / LINES), i + 1));
  }
  const doc = buildDocument([{ content: parts.join('\n'), mediabox: [0, 0, 612, 792] }]);
  const buffer = doc.saveToBuffer('compress');
  const bytes = buffer.asUint8Array().slice();
  buffer.destroy();
  doc.destroy();
  return bytes;
}

function session(bytes: Uint8Array): PdfSession {
  const s = new PdfSession({ loadFallbackFont: async () => FONT_BYTES });
  s.open(bytes);
  return s;
}

const text = (s: PdfSession): string =>
  s
    .extractPage({ pageIndex: 0 })
    .chars.map((c) => c.text)
    .join('');

function input(plan: ParagraphEditPlan, value: string): DraftInput {
  return {
    runs: [{ text: value, style: plan.runs[0]!.style }],
    format: plan.format,
    composition: null,
    renderScale: 1,
  };
}

/** `Paragraph n` 문단을 연다(커밋하지 않는다). */
async function begin(s: PdfSession, n: number) {
  const paragraph = s.getPageLayout(0).paragraphs.find((p) => p.text.startsWith(`Paragraph ${n} `));
  if (!paragraph) throw new Error(`문단 없음: ${n}`);
  const plan = await s.planParagraphEdit(0, paragraph.id);
  expect(plan.editable, JSON.stringify(plan.limits)).toBe(true);
  const started = await s.beginParagraphEdit(0, paragraph.id, plan.revision);
  await s.updateParagraphDraft(started.draftId, input(plan, `Paragraph ${n} edited text.`));
  return started.draftId;
}

async function edit(s: PdfSession, n: number): Promise<EditOp> {
  return (await s.commitParagraphEdit(await begin(s, n))).op;
}

/** 쪽 /Contents 스트림(한 개)의 필터·저장 길이·풀린 길이. */
function contentsInfo(s: PdfSession): { filter: string | null; stored: number; plain: number } {
  const contents = s.document.findPage(0).get('Contents');
  const stream = contents.isArray() ? contents.get(0) : contents;
  const filter = stream.get('Filter');
  const buffer = stream.readStream();
  try {
    return {
      filter: filter.isNull() ? null : filter.asName(),
      stored: stream.get('Length').asNumber(),
      plain: buffer.getLength(),
    };
  } finally {
    buffer.destroy();
  }
}

function pixels(s: PdfSession): Uint8ClampedArray {
  return s.renderPage({ pageIndex: 0, scale: 1 }).rgba;
}

function reopen(bytes: Uint8Array): PdfSession {
  return session(bytes);
}

describe('편집 커밋의 스트림 압축(실제 어댑터)', { timeout: 120_000 }, () => {
  it('커밋한 큰 쪽 콘텐츠는 FlateDecode 로 압축되고 저널 추정은 압축 크기다', async () => {
    const s = session(heavyPdf(400_000));
    await edit(s, 1);
    const info = contentsInfo(s);
    expect(info.filter).toBe('FlateDecode');
    expect(info.plain).toBeGreaterThan(400_000);
    expect(info.stored).toBeLessThan(info.plain / 3);
    // 저널 추정 = 커밋이 바꾼 스트림 /Length 합(압축 콘텐츠 + 작은 편집 블록).
    const journal = s.journalAdvice().journalBytes;
    expect(journal).toBeGreaterThanOrEqual(info.stored);
    expect(journal).toBeLessThan(info.stored + 20_000);
    s.close();
  });

  it('결과 동일: 압축한 세션 = 풀린 채 재적용한 세션(쪽 텍스트·렌더 픽셀·저장 재열기)', async () => {
    const source = heavyPdf(300_000);
    const live = session(source);
    const ops = [await edit(live, 2), await edit(live, 5), await edit(live, 2)];
    expect(contentsInfo(live).filter).toBe('FlateDecode');
    const replayed = session(source);
    await replayed.replayEdits(structuredClone(ops));
    // 재적용은 저널 밖이라 압축하지 않는다(풀린 채 둔다): 같은 내용이 다른 저장 형태로 있다.
    expect(contentsInfo(replayed).filter).toBeNull();
    expect(text(live)).toBe(text(replayed));
    expect(text(live)).toContain('Paragraph 5 edited text.');
    expect(pixels(live)).toEqual(pixels(replayed));
    const savedLive = reopen(live.save({ changes: [] }).bytes);
    const savedReplayed = reopen(replayed.save({ changes: [] }).bytes);
    expect(text(savedLive)).toBe(text(live));
    expect(text(savedReplayed)).toBe(text(live));
    expect(pixels(savedLive)).toEqual(pixels(live));
    expect(pixels(savedReplayed)).toEqual(pixels(live));
    for (const s of [live, replayed, savedLive, savedReplayed]) s.close();
  });

  it('되돌리기·다시 실행: 압축한 판 사이를 오가며 저널 단계는 편집 수와 같다', async () => {
    const s = session(heavyPdf(200_000));
    const original = text(s);
    await edit(s, 1);
    const one = text(s);
    await edit(s, 3);
    const two = text(s);
    await edit(s, 6);
    const three = text(s);
    expect(s.document.getJournal().steps).toHaveLength(3);
    await s.undo();
    expect(text(s)).toBe(two);
    await s.undo();
    expect(text(s)).toBe(one);
    await s.undo();
    expect(text(s)).toBe(original);
    await s.redo();
    await s.redo();
    await s.redo();
    expect(text(s)).toBe(three);
    expect(contentsInfo(s).filter).toBe('FlateDecode');
    s.close();
  });

  it('패스 편집 커밋도 큰 쪽 콘텐츠를 압축한다', async () => {
    const s = session(heavyPdf(200_000));
    const e = await s.getPageEditability(0);
    const line = e.paths.find((p) => p.editable);
    expect(line).toBeDefined();
    const plan = await s.planPathEdit(0, [line!.paintSeq]);
    const started = await s.beginPathEdit(0, [line!.paintSeq], plan.revision);
    const move: PathEdit = {
      transform: [1, 0, 0, 1, 0, 30],
      fill: null,
      stroke: null,
      lineWidth: null,
      points: null,
      delete: false,
    };
    await s.updatePathDraft(started.draftId, move, 1);
    await s.commitPathEdit(started.draftId);
    expect(contentsInfo(s).filter).toBe('FlateDecode');
    await s.undo();
    expect(contentsInfo(s).filter).toBe('FlateDecode');
    s.close();
  });

  it('커밋하는 동안(압축 대기) 같은 초안의 갱신·커밋·취소를 거절한다', async () => {
    const s = session(heavyPdf(300_000));
    const draftId = await begin(s, 4);
    const first = s.commitParagraphEdit(draftId);
    await expect(s.commitParagraphEdit(draftId)).rejects.toThrow(/커밋하는 중/);
    await expect(s.cancelParagraphEdit(draftId)).rejects.toThrow(/커밋하는 중/);
    await expect(first).resolves.toMatchObject({ history: { edits: 1 } });
    expect(text(s)).toContain('Paragraph 4 edited text.');
    s.close();
  });

  it('WASM 사용 중 힙: 큰 쪽 문단을 처음 고칠 때마다 풀린 크기가 아니라 압축 크기만큼 는다', async () => {
    const fill = 3 * MiB;
    const s = session(heavyPdf(fill));
    // 첫 편집은 폴백 폰트 임베딩(약 8 MB)이 섞이므로 그 뒤를 기준으로 잰다.
    await edit(s, 1);
    const base = probeWasmHeap({ emptyStore: true })!.usedBytes;
    for (const n of [2, 3, 4, 5, 6]) await edit(s, n);
    const grown = probeWasmHeap({ emptyStore: true })!.usedBytes - base;
    const { stored, plain } = contentsInfo(s);
    expect(plain).toBeGreaterThan(fill);
    // 압축 전 동작이면 편집 5건 × 풀린 크기(약 15 MiB)가 남는다. 압축 크기 5건 + 여유 4 MiB 이하이고 풀린 크기 2건 미만.
    expect(stored).toBeLessThan(plain / 3);
    expect(grown).toBeLessThan(5 * stored + 4 * MiB);
    expect(grown).toBeLessThan(2 * plain);
    s.close();
  });
});

// 압축 경로가 MuPDF 렌더와 같은 바이트를 읽는지(원본 Flate 콘텐츠와 비교): 위 시험의 전제 확인.
describe('합성 문서 전제', () => {
  it('원본 콘텐츠는 Flate 이고 주석은 렌더에 영향이 없다', () => {
    const bytes = heavyPdf(100_000);
    const doc = mupdf.PDFDocument.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument;
    const contents = doc.findPage(0).get('Contents');
    expect(contents.get('Filter').asName()).toBe('FlateDecode');
    const s = session(bytes);
    expect(text(s)).toContain('Paragraph 8 original text here.');
    s.close();
    doc.destroy();
  });
});
