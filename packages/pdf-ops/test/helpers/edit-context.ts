/**
 * Page state for M3 paragraph edit tests (ParagraphEditContext). Loads the original core extraction (extractPageModel) and layout-recon
 * (reconstructPage) through vitest aliases to build the same PageModel and PageLayout as the real flow.
 */
import * as mupdf from 'mupdf';
import type { PageLayout, PageModel } from '@pdf-editor/shared-types';
import {
  buildSourceMap,
  editBlockLineGroups,
  linkPage,
  listEditBlocks,
  type ParagraphEditContext,
} from '../../src/index.js';

interface CoreExtract {
  extractPageModel(
    page: mupdf.PDFPage,
    request: { pageIndex: number; includePathSegments?: boolean },
  ): PageModel;
}
interface LayoutRecon {
  reconstructPage(model: PageModel, options?: { fixedGroups?: number[][] }): PageLayout;
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

/**
 * Builds the page state (await loadModules first). segments: also extracts PathInfo.segments (M4 point editing, ruled table detection).
 * fixedGroups: passes edit block line groups as layout hints, as core getPageLayout does (docs/m3-integration.md 9.6).
 */
export function pageContext(
  doc: mupdf.PDFDocument,
  pageIndex: number,
  options: { segments?: boolean; fixedGroups?: boolean } = {},
): ParagraphEditContext {
  if (!mods) throw new Error('loadModules() 를 먼저 부른다');
  const page = doc.loadPage(pageIndex);
  let model: PageModel;
  try {
    model = mods.core.extractPageModel(page, {
      pageIndex,
      includePathSegments: options.segments === true,
    });
  } finally {
    page.destroy();
  }
  const map = buildSourceMap(doc, pageIndex);
  const linkage = linkPage(model, map);
  const editBlocks = listEditBlocks(doc, pageIndex);
  const layout = mods.layout.reconstructPage(
    model,
    options.fixedGroups
      ? { fixedGroups: editBlockLineGroups(model, map, linkage, editBlocks) }
      : undefined,
  );
  return { doc, pageIndex, model, map, linkage, layout, editBlocks };
}

export function reopen(src: mupdf.PDFDocument, options = ''): mupdf.PDFDocument {
  return mupdf.Document.openDocument(
    src.saveToBuffer(options).asUint8Array().slice(),
    'application/pdf',
  ) as mupdf.PDFDocument;
}

/** Finds a paragraph by paragraph text (comparison that also ignores whitespace). */
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
