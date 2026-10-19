/**
 * M3 통합(docs/m3-contract.md 7절): 실제 pdf-ops·reflow 어댑터(defaultEditAdapter)로 core 편집 흐름을 돈다.
 * 가짜 어댑터 시험(edit-engine·edit-save-replay)의 저널·로그 단언과 별개로, 실제 제거·삽입·폰트·배치·쓰기를 거친
 * 결과(텍스트·순서·폴백·저장·재열기·재편집·재적용 결정성)를 확인한다.
 */
import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import type { DraftInput, EditOp, ParagraphEditPlan, TextRun } from '@pdf-editor/shared-types';
import { PdfSession } from '../src/index.js';
import { FONT_BYTES, MEDIABOX, PAGE, fallbackFonts } from './edit-harness.js';
import { buildPdf } from './pdf-fixtures.js';

function session(bytes: Uint8Array): PdfSession {
  const s = new PdfSession({ loadFallbackFont: async () => FONT_BYTES });
  s.open(bytes);
  return s;
}

const source = (): Uint8Array => buildPdf([{ content: PAGE, mediabox: MEDIABOX }]);

/** MuPDF 구조화 텍스트(콘텐츠 순서). */
function stext(bytesOrSession: Uint8Array | PdfSession, pageIndex = 0): string {
  if (bytesOrSession instanceof PdfSession) {
    return bytesOrSession
      .extractPage({ pageIndex })
      .chars.map((c) => c.text)
      .join('');
  }
  const doc = mupdf.Document.openDocument(bytesOrSession, 'application/pdf');
  try {
    const page = doc.loadPage(pageIndex);
    const text = page.toStructuredText('preserve-whitespace').asText();
    page.destroy();
    return text;
  } finally {
    doc.destroy();
  }
}

const squash = (t: string): string => t.replace(/\s+/gu, '');

async function paragraphId(s: PdfSession, startsWith: string, pageIndex = 0): Promise<number> {
  const layout = s.getPageLayout(pageIndex);
  const found = layout.paragraphs.find((p) => p.text.startsWith(startsWith));
  if (!found) throw new Error(`문단 없음: ${startsWith}`);
  return found.id;
}

function input(plan: ParagraphEditPlan, text: string): DraftInput {
  const run: TextRun = { text, style: plan.runs[0]!.style };
  return { runs: [run], format: plan.format, composition: null, renderScale: 2 };
}

async function edit(s: PdfSession, startsWith: string, text: string) {
  const id = await paragraphId(s, startsWith);
  const plan = await s.planParagraphEdit(0, id);
  expect(plan.editable, JSON.stringify(plan.limits)).toBe(true);
  const started = await s.beginParagraphEdit(0, id, plan.revision);
  const update = await s.updateParagraphDraft(started.draftId, input(plan, text));
  const commit = await s.commitParagraphEdit(started.draftId);
  return { plan, update, commit };
}

const NEW_TEXT = 'Edited paragraph 한글 문장 漢字 with fallback glyphs and more words to wrap.';

describe('실제 어댑터 편집 흐름(M3 통합)', () => {
  it('판정 → 시작 → 갱신 → 커밋: 새 텍스트가 원래 자리(제목과 둘째 문단 사이)에 있고 폴백 경고가 난다', async () => {
    const s = session(source());
    const editability = await s.getPageEditability(0);
    expect(editability.paragraphs.filter((p) => p.editable).length).toBeGreaterThanOrEqual(3);

    const { plan, update, commit } = await edit(s, 'first paragraph', NEW_TEXT);
    expect(plan.insertion).not.toBeNull();
    expect(update.reflow.lines.length).toBeGreaterThan(0);
    expect(update.warnings.map((w) => w.kind)).toContain('font-fallback');
    expect(commit.op.kind).toBe('replace-paragraph');

    const t = squash(stext(s));
    expect(t).toContain(squash(NEW_TEXT));
    expect(t).not.toContain('firstparagraphlineone');
    // A9: 콘텐츠 순서상 제목 < 새 문단 < 둘째 문단.
    const iTitle = t.indexOf('TitleHeading');
    const iNew = t.indexOf(squash(NEW_TEXT));
    const iSecond = t.indexOf('Secondparagraph');
    expect(iTitle).toBeGreaterThanOrEqual(0);
    expect(iTitle).toBeLessThan(iNew);
    expect(iNew).toBeLessThan(iSecond);
    s.close();
  });

  it('undo·redo 로 원문과 편집본을 오가고, 폴백 초안 취소 뒤 새 편집 → 저장이 된다(V1)', async () => {
    const s = session(source());
    await edit(s, 'first paragraph', NEW_TEXT);
    await s.undo();
    expect(squash(stext(s))).toContain('firstparagraphlineone');
    await s.redo();
    expect(squash(stext(s))).toContain(squash(NEW_TEXT));

    // 폴백을 쓰는 초안을 취소한 뒤 다른 문단을 편집한다.
    const id = await paragraphId(s, 'Second');
    const plan = await s.planParagraphEdit(0, id);
    const started = await s.beginParagraphEdit(0, id, plan.revision);
    await s.updateParagraphDraft(started.draftId, input(plan, '취소할 초안 한글'));
    await s.cancelParagraphEdit(started.draftId);
    expect(squash(stext(s))).toContain('Secondparagraphstartshereandends.');
    await edit(s, 'Second', '둘째 문단 새 텍스트');

    const saved = s.save({ changes: [] });
    expect(saved.method).toBe('full');
    const reopened = squash(stext(saved.bytes));
    expect(reopened).toContain(squash(NEW_TEXT));
    expect(reopened).toContain('둘째문단새텍스트');
    s.close();
  });

  it('저장 파일: 폴백 폰트는 서브셋, Info /PdfEditorEdits 기록, 재열기 새 세션에서 같은 블록을 다시 쓴다', async () => {
    const s = session(source());
    await edit(s, 'first paragraph', NEW_TEXT);
    const saved = s.save({ changes: [] });
    s.close();
    const doc = mupdf.Document.openDocument(saved.bytes, 'application/pdf').asPDF()!;
    expect(doc.getTrailer().get('Info').get('PdfEditorEdits').asString()).toContain('pages=1');
    // 폴백 폰트(표지 /PdfEditorFallback)는 하나이고 FontFile2 는 쓴 글리프만 남긴 서브셋이다(A7-1).
    // 픽스처의 F2 는 같은 폰트 전체를 담고 있어 파일 크기로는 판정하지 않는다.
    const fallback = fallbackFonts(doc);
    expect(fallback.length).toBe(1);
    const descendant = fallback[0]!.get('DescendantFonts').get(0);
    const fontFile = descendant.get('FontDescriptor').get('FontFile2');
    expect(fontFile.readStream().getLength()).toBeLessThan(FONT_BYTES.byteLength / 10);
    doc.destroy();

    const s2 = session(saved.bytes);
    const id = await paragraphId(s2, 'Edited paragraph');
    const plan = await s2.planParagraphEdit(0, id);
    expect(plan.editable, JSON.stringify(plan.limits)).toBe(true);
    expect(plan.insertion?.mode).toBe('rewrite-block');
    expect(squash(plan.runs.map((r) => r.text).join(''))).toBe(squash(NEW_TEXT));
    const started = await s2.beginParagraphEdit(0, id, plan.revision);
    await s2.updateParagraphDraft(started.draftId, input(plan, 'Second session text 다시'));
    await s2.commitParagraphEdit(started.draftId);
    const resaved = s2.save({ changes: [] });
    const t = squash(stext(resaved.bytes));
    expect(t).toContain('Secondsessiontext다시');
    expect(t).not.toContain(squash(NEW_TEXT));
    s2.close();
  });

  it('재적용(D6): 같은 로그를 새 문서에 두 번 적용하면 원래 편집과 같은 텍스트, 저장 파일 렌더·텍스트도 같다', async () => {
    const live = session(source());
    const ops: EditOp[] = [];
    ops.push((await edit(live, 'first paragraph', NEW_TEXT)).commit.op);
    ops.push((await edit(live, 'Second', '둘째 문단 새 텍스트')).commit.op);
    const expectedText = stext(live);

    const a = session(source());
    const b = session(source());
    await a.replayEdits(structuredClone(ops));
    await b.replayEdits(structuredClone(ops));
    expect(stext(a)).toBe(expectedText);
    expect(stext(b)).toBe(expectedText);
    // 저장 바이트는 Info /ModDate(커밋 시각)가 달라 비교하지 않는다. 저장 파일의 렌더 픽셀·텍스트를 비교한다.
    const pixels = (bytes: Uint8Array) => {
      const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
      const page = doc.loadPage(0);
      const pix = page.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false);
      const out = Buffer.from(pix.getPixels());
      pix.destroy();
      page.destroy();
      doc.destroy();
      return out;
    };
    const savedA = a.save({ changes: [] }).bytes;
    const savedB = b.save({ changes: [] }).bytes;
    const savedLive = live.save({ changes: [] }).bytes;
    expect(pixels(savedA).equals(pixels(savedB))).toBe(true);
    expect(pixels(savedA).equals(pixels(savedLive))).toBe(true);
    expect(stext(savedA)).toBe(stext(savedLive));
    for (const x of [live, a, b]) x.close();
  });
});
