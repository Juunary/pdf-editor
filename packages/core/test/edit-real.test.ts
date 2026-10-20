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

/** F1(Helvetica) 하나를 쓰는 문서. tweak 으로 폰트 사전을 바꾼다(ToUnicode·Encoding). */
function helveticaPdf(
  pages: string[],
  tweak: (doc: mupdf.PDFDocument, f1: mupdf.PDFObject) => void,
) {
  const doc = new mupdf.PDFDocument();
  const f1 = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  tweak(doc, f1);
  for (const content of pages) {
    doc.insertPage(-1, doc.addPage([0, 0, 400, 300], 0, { Font: { F1: f1 } }, content));
  }
  const buffer = doc.saveToBuffer('');
  const bytes = buffer.asUint8Array().slice();
  buffer.destroy();
  doc.destroy();
  return bytes;
}

const toUnicode = (doc: mupdf.PDFDocument, body: string): mupdf.PDFObject =>
  doc.addStream(
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def ' +
      `1 begincodespacerange <00> <FF> endcodespacerange ${body} endcmap ` +
      'CMapName currentdict /CMap defineresource pop end end',
    doc.newDictionary(),
  );

async function editAt(s: PdfSession, pageIndex: number, startsWith: string, text: string) {
  const id = await paragraphId(s, startsWith, pageIndex);
  const plan = await s.planParagraphEdit(pageIndex, id);
  expect(plan.editable, JSON.stringify(plan.limits)).toBe(true);
  const started = await s.beginParagraphEdit(pageIndex, id, plan.revision);
  const update = await s.updateParagraphDraft(started.draftId, input(plan, text));
  const commit = await s.commitParagraphEdit(started.draftId);
  return { plan, update, commit };
}

/** 쪽의 편집 블록(/PdfEditorEdit Form) 콘텐츠. */
function blockContents(s: PdfSession, pageIndex: number): string[] {
  const doc = mupdf.Document.openDocument(s.save({ changes: [] }).bytes, 'application/pdf');
  const pdf = doc.asPDF()!;
  const out: string[] = [];
  pdf
    .findPage(pageIndex)
    .get('Resources')
    .get('XObject')
    .forEach((x) => {
      if (!x.get('PdfEditorEdit').isNull()) out.push(x.readStream().asString());
    });
  doc.destroy();
  return out;
}

describe('마일스톤 리뷰 반영(docs/m3-integration.md 8절)', () => {
  it('H1: ToUnicode 가 분해형(NFD)인 원문도 같은 텍스트 커밋에서 글자를 잃지 않는다', async () => {
    // 코드 E9 → "e" + U+0301(분해형). 나머지 ASCII 는 그대로.
    const bytes = helveticaPdf(
      [
        'BT /F1 12 Tf 50 250 Td (Le caf\\351 et le th\\351 du matin.) Tj ET\n' +
          'BT /F1 12 Tf 50 120 Td (Second paragraph starts here and ends.) Tj ET\n',
      ],
      (doc, f1) =>
        f1.put(
          'ToUnicode',
          toUnicode(
            doc,
            '1 beginbfrange <20> <7E> <0020> endbfrange 1 beginbfchar <E9> <00650301> endbfchar',
          ),
        ),
    );
    const s = session(bytes);
    const layout = s.getPageLayout(0);
    const target = layout.paragraphs.find((p) => p.text.startsWith('Le caf'))!;
    expect(target.text).toContain('é'); // 추출은 ToUnicode 그대로(분해형)
    const plan = await s.planParagraphEdit(0, target.id);
    const text = plan.runs.map((r) => r.text).join('');
    expect(text).toBe(text.normalize('NFC'));
    expect(text.normalize('NFC')).toBe(target.text.normalize('NFC'));
    expect(plan.charIndexOfOffset).toHaveLength(text.length);
    // 'é'(NFC 한 위치)는 원래 클러스터의 첫 글자를 가리킨다.
    const at = text.indexOf('é');
    expect(layout.paragraphs).toBeDefined();
    expect(plan.charIndexOfOffset[at]).toBeGreaterThanOrEqual(0);
    const started = await s.beginParagraphEdit(0, target.id, plan.revision);
    const update = await s.updateParagraphDraft(started.draftId, {
      runs: plan.runs,
      format: plan.format,
      composition: null,
      renderScale: 2,
    });
    expect(update.warnings.map((w) => w.kind)).not.toContain('glyph-missing');
    expect(update.warnings.map((w) => w.kind)).not.toContain('font-fallback');
    await s.commitParagraphEdit(started.draftId);
    const after = squash(stext(s)).normalize('NFC');
    expect(after).toContain(squash(text));
    const saved = squash(stext(s.save({ changes: [] }).bytes)).normalize('NFC');
    expect(saved).toContain(squash(text));
    s.close();
  });

  it('H1: 결합 문자만 두 폰트에 없으면 기본 글자는 남기고 그 결합 문자만 glyph-missing', async () => {
    const s = session(source());
    // q + U+0301: 미리 합친 글자가 없고 Helvetica(WinAnsi)·폴백 모두 U+0301 이 없다.
    const { update } = await edit(s, 'first paragraph', 'Aq́z end.');
    const missing = update.warnings.find((w) => w.kind === 'glyph-missing');
    expect(missing?.message).toContain('́');
    const t = squash(stext(s));
    expect(t).toContain('Aqzend.');
    s.close();
  });

  it('M1: 공백만 폴백으로 가도 저장 폴백 폰트는 서브셋이고 변경 종류에 font-embed 가 있다', async () => {
    // ToUnicode 에 U+0020 이 없어 공백은 원본 폰트로 쓸 수 없다(폴백으로 감, font-fallback 경고 없음).
    const bytes = helveticaPdf(
      [
        'BT /F1 12 Tf 50 250 Td (Hello world first paragraph here.) Tj ET\n' +
          'BT /F1 12 Tf 50 120 Td (Second paragraph starts here and ends.) Tj ET\n',
      ],
      (doc, f1) =>
        f1.put('ToUnicode', toUnicode(doc, '1 beginbfrange <21> <7E> <0021> endbfrange')),
    );
    const s = session(bytes);
    const { update } = await edit(s, 'Hello', 'New words with spaces inside it');
    expect(update.warnings.map((w) => w.kind)).not.toContain('font-fallback');
    const plan = s.planSave({ changes: [] });
    expect(plan.reason).toContain('font-embed');
    const saved = s.save({ changes: [] });
    s.close();
    const doc = mupdf.Document.openDocument(saved.bytes, 'application/pdf').asPDF()!;
    const fallback = fallbackFonts(doc);
    expect(fallback.length).toBe(1);
    const fontFile = fallback[0]!
      .get('DescendantFonts')
      .get(0)
      .get('FontDescriptor')
      .get('FontFile2');
    expect(fontFile.readStream().getLength()).toBeLessThan(FONT_BYTES.byteLength / 10);
    expect(squash(stext(saved.bytes))).toContain('Newwordswithspacesinsideit');
    doc.destroy();
  });

  it('M3: 같은 편집은 세션 이력과 관계없이 같은 코드로 쓴다(같은 유니코드의 코드가 여럿)', async () => {
    // 'A' = 코드 65(WinAnsi)와 200(Differences). 0쪽은 200, 1쪽은 65 를 쓴다.
    const bytes = helveticaPdf(
      [
        'BT /F1 12 Tf 50 250 Td (Used \\310 code on page one.) Tj ET\n' +
          'BT /F1 12 Tf 50 120 Td (Second paragraph starts here and ends.) Tj ET\n',
        'BT /F1 12 Tf 50 250 Td (Plain A text on page two.) Tj ET\n' +
          'BT /F1 12 Tf 50 120 Td (Another paragraph on page two.) Tj ET\n',
      ],
      (doc, f1) => {
        f1.delete('ToUnicode');
        const enc = doc.newDictionary();
        enc.put('BaseEncoding', doc.newName('WinAnsiEncoding'));
        const diff = doc.newArray();
        diff.push(200);
        diff.push(doc.newName('A'));
        enc.put('Differences', diff);
        f1.put('Encoding', enc);
      },
    );
    // 세션 1: 1쪽을 먼저 편집(폰트를 1쪽 상태로 처음 만듦)한 뒤 0쪽 편집.
    const s1 = session(bytes);
    await editAt(s1, 1, 'Plain', 'Page two edited.');
    await editAt(s1, 0, 'Used', 'AAA new');
    // 세션 2: 0쪽만 편집.
    const s2 = session(bytes);
    await editAt(s2, 0, 'Used', 'AAA new');
    const b1 = blockContents(s1, 0);
    const b2 = blockContents(s2, 0);
    expect(b1).toHaveLength(1);
    expect(b1).toEqual(b2);
    // 0쪽 상태에서 쓰인 코드(200 = C8)를 고른다.
    expect(b1[0]!.toLowerCase()).toContain('[<c8> <c8> <c8> <20>');
    s1.close();
    s2.close();
  });
});

describe('사용자 확인 후 수정(docs/m3-integration.md 9절)', () => {
  it('B1: 커밋한 편집 블록을 레이아웃이 여러 문단으로 나눠도 편집 판정은 블록 하나(상자 = 블록 글자 상자)', async () => {
    const s = session(source());
    const { commit } = await edit(s, 'first paragraph', 'Short line one.\nShort line two.');
    // 전제: 레이아웃 복원은 강제 줄바꿈 뒤 짧은 줄을 다른 문단으로 본다(블록 하나가 문단 둘).
    const layout = s.getPageLayout(0);
    expect(layout.paragraphs.filter((p) => p.text.startsWith('Short line')).length).toBe(2);
    const e = await s.getPageEditability(0);
    const own = e.paragraphs.filter((p) => p.editedBlock === commit.op.id);
    expect(own).toHaveLength(1);
    const lines = layout.paragraphs.filter((p) => p.text.startsWith('Short line'));
    const [x0, y0, x1, y1] = own[0]!.bbox;
    for (const p of lines) {
      expect(p.bbox[0]).toBeGreaterThanOrEqual(x0 - 1);
      expect(p.bbox[1]).toBeGreaterThanOrEqual(y0 - 1);
      expect(p.bbox[2]).toBeLessThanOrEqual(x1 + 1);
      expect(p.bbox[3]).toBeLessThanOrEqual(y1 + 1);
    }
    // 그 항목으로 다시 편집하면 대상은 블록 전체다.
    const plan = await s.planParagraphEdit(0, own[0]!.paragraphId);
    expect(plan.target.editedBlock).toBe(commit.op.id);
    expect(plan.runs.map((r) => r.text).join('')).toBe('Short line one.\nShort line two.');
    s.close();
  });

  it('B1: 블록이 이웃 문단과 한 레이아웃 문단으로 합쳐져도 판정 상자는 블록 글자만 덮는다', async () => {
    const s = session(source());
    const long = 'Short line one. Next starts. '.repeat(8).trim();
    const { commit } = await edit(s, 'first paragraph', long);
    const e = await s.getPageEditability(0);
    const own = e.paragraphs.filter((p) => p.editedBlock === commit.op.id);
    expect(own).toHaveLength(1);
    // 둘째 문단(기준선 y = 792 − 640 = 152) 줄은 상자 밖이다.
    expect(own[0]!.bbox[3]).toBeLessThan(150);
    s.close();
  });
});
