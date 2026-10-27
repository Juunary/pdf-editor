/**
 * Paragraph edit flow (contract paragraph-edit.ts header): plan -> prepare -> (assign -> layout -> write).
 * The layout is the test-only simpleReflow (the reflow package is not implemented).
 */
import { readFileSync } from 'node:fs';
import type * as mupdf from 'mupdf';
import type { ParagraphEditPlan, TextRun } from '@pdf-editor/shared-types';
import {
  embedFont,
  FontManager,
  type FallbackFontSource,
  planParagraphEdit,
  prepareParagraphEdit,
  writeEditBlock,
  type ParagraphEditContext,
  type PreparedEdit,
} from '../../src/index.js';
import { simpleReflow } from './simple-reflow.js';

export const FALLBACK_PATH = new URL(
  '../../../../assets/fonts/NotoSansKR-Regular-subset.ttf',
  import.meta.url,
);
let fallbackBytes: Uint8Array | null = null;
export const loadFallback = (): Uint8Array =>
  (fallbackBytes ??= new Uint8Array(readFileSync(FALLBACK_PATH)));

/**
 * Same fallback source as core (contract D4 amendment 1): puts the fallback font in once before the journal is turned on (outside an operation).
 * With embed false, ref() is null as in the classification stage.
 */
export function fallbackFor(doc: mupdf.PDFDocument, embed = true): FallbackFontSource {
  const ref = embed ? embedFont(doc, 'NotoSansKR', loadFallback()).ref : null;
  return { bytes: loadFallback, ref: () => ref };
}

let seq = 0;
export const newEditId = () => `edit-${++seq}`;

export interface EditRun {
  plan: Omit<ParagraphEditPlan, 'revision'>;
  prepared: PreparedEdit;
  runs: TextRun[];
  text: string;
  warnings: ReturnType<FontManager['assign']>['warnings'];
  result: ReturnType<typeof simpleReflow>;
}

/** Replaces a paragraph with new text (the start text as is if absent). */
export function editParagraph(
  ctx: ParagraphEditContext,
  fm: FontManager,
  paragraphId: number,
  text?: string | TextRun[],
): EditRun {
  const plan = planParagraphEdit(ctx, fm, paragraphId);
  if (!plan.editable) {
    throw new Error(`편집 불가: ${plan.limits.map((l) => `${l.reason}(${l.detail})`).join(', ')}`);
  }
  const prepared = prepareParagraphEdit(ctx, plan, newEditId());
  const runs: TextRun[] =
    text === undefined
      ? plan.runs
      : typeof text === 'string'
        ? [{ text, style: plan.runs[0]!.style }]
        : text;
  return writeRuns(ctx, fm, plan, prepared, runs);
}

/** One draft update (assign -> layout -> write). */
export function writeRuns(
  ctx: ParagraphEditContext,
  fm: FontManager,
  plan: Omit<ParagraphEditPlan, 'revision'>,
  prepared: PreparedEdit,
  runs: TextRun[],
): EditRun {
  const all = runs.map((r) => r.text).join('');
  const { segments, warnings } = fm.assign(ctx, all, runs);
  const result = simpleReflow(all, segments, plan.format);
  writeEditBlock(ctx, prepared, runs, plan.format, result, fm);
  return { plan, prepared, runs, text: all, warnings, result };
}
