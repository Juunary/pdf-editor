/**
 * 문단 편집 흐름(계약 paragraph-edit.ts 머리말): plan → prepare → (assign → 배치 → write).
 * 배치는 테스트 전용 simpleReflow 다(reflow 패키지 미구현).
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
 * core 와 같은 폴백 원천(계약 D4 수정 1): 저널을 켜기 전(작업 밖)에 폴백 폰트를 한 번 넣어 둔다.
 * embed false 면 판정 단계처럼 ref() 가 null.
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

/** 문단을 새 텍스트(없으면 시작 텍스트 그대로)로 바꾼다. */
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

/** 초안 갱신 한 번(assign → 배치 → write). */
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
