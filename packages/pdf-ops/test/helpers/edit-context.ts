/**
 * M3 문단 편집 테스트용 쪽 상태(ParagraphEditContext). core 추출(extractPageModel)과 layout-recon
 * (reconstructPage) 원본을 vitest 별칭으로 불러 실제 흐름과 같은 PageModel·PageLayout 을 만든다.
 */
import * as mupdf from 'mupdf';
import type { PageLayout, PageModel } from '@pdf-editor/shared-types';
import {
  buildSourceMap,
  linkPage,
  listEditBlocks,
  type ParagraphEditContext,
} from '../../src/index.js';

interface CoreExtract {
  extractPageModel(page: mupdf.PDFPage, request: { pageIndex: number }): PageModel;
}
interface LayoutRecon {
  reconstructPage(model: PageModel): PageLayout;
}

const CORE = '@pdf-editor-test/core-extract';
const LAYOUT = '@pdf-editor/layout-recon';
let mods: { core: CoreExtract; layout: LayoutRecon } | null = null;

export async function loadModules(): Promise<{ core: CoreExtract; layout: LayoutRecon }> {
  mods ??= {
    core: (await import(/* @vite-ignore */ CORE)) as CoreExtract,
    layout: (await import(/* @vite-ignore */ LAYOUT)) as LayoutRecon,
  };
  return mods;
}

/** 쪽 상태를 만든다(loadModules 를 먼저 await). */
export function pageContext(doc: mupdf.PDFDocument, pageIndex: number): ParagraphEditContext {
  if (!mods) throw new Error('loadModules() 를 먼저 부른다');
  const page = doc.loadPage(pageIndex);
  let model: PageModel;
  try {
    model = mods.core.extractPageModel(page, { pageIndex });
  } finally {
    page.destroy();
  }
  const map = buildSourceMap(doc, pageIndex);
  const linkage = linkPage(model, map);
  const layout = mods.layout.reconstructPage(model);
  return {
    doc,
    pageIndex,
    model,
    map,
    linkage,
    layout,
    editBlocks: listEditBlocks(doc, pageIndex),
  };
}

export function reopen(src: mupdf.PDFDocument, options = ''): mupdf.PDFDocument {
  return mupdf.Document.openDocument(
    src.saveToBuffer(options).asUint8Array().slice(),
    'application/pdf',
  ) as mupdf.PDFDocument;
}

/** 문단 텍스트로 문단 찾기(공백 무시 포함 비교). */
export function findParagraph(ctx: ParagraphEditContext, needle: string) {
  const squash = (s: string) => s.replace(/\s+/g, '');
  const p = ctx.layout.paragraphs.find((q) => squash(q.text).includes(squash(needle)));
  if (!p) {
    throw new Error(
      `문단 없음: ${needle} / 있는 문단: ${ctx.layout.paragraphs.map((q) => JSON.stringify(q.text)).join(' | ')}`,
    );
  }
  return p;
}
