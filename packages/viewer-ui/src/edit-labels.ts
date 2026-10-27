/**
 * Chooses edit-limit reason and edit warning text in the display language. Tables are in labels-data.ts; the language is `ViewerStrings` (strings.ts).
 *
 * The reason descriptions (`ParagraphLimit.detail`, `PathLimit.detail`) and warning sentences (`EditWarning.message`) produced by core and pdf-ops
 * are in Korean. The Korean UI uses those sentences as is (they carry more specific diagnostic information); the English UI builds sentences from
 * the tables using reason codes, warning kinds and numbers (user decision 2026-10-26).
 */
import type { EditWarning } from '@pdf-editor/shared-types';
import type { WarningTextKey } from './labels-data.js';
import { VIEWER_STRINGS, type ViewerStrings } from './strings.js';

export * from './labels-data.js';

/** Reason code → display-language text. A code not in the table becomes "편집할 수 없습니다 (code)". */
export function limitLabel(reason: string, t: ViewerStrings = VIEWER_STRINGS.ko): string {
  return (t.limitLabels as Record<string, string>)[reason] ?? t.limitUnknown(reason);
}

/**
 * Limit list → popover/path panel text (deduplicated). The Korean UI uses the core description (detail) if present, the English UI uses the reason-code
 * text. If empty, a single fallback line.
 */
export function limitItems(
  limits: readonly { reason: string; detail: string }[],
  fallback: string,
  t: ViewerStrings = VIEWER_STRINGS.ko,
): string[] {
  const items = limits.map((l) =>
    t.lang === 'ko' && l.detail !== '' ? l.detail : limitLabel(l.reason, t),
  );
  return items.length > 0 ? [...new Set(items)] : [fallback];
}

/** Edit warning → display-language sentence. The Korean UI uses the core sentence (message) as is if present; the English UI builds it from kind and numbers. */
export function warningText(w: EditWarning, t: ViewerStrings = VIEWER_STRINGS.ko): string {
  if (t.lang === 'ko' && w.message !== '') return w.message;
  const key = (w.variant ? `${w.kind}:${w.variant}` : w.kind) as WarningTextKey;
  const text = t.warningTexts[key] ?? t.warningTexts[w.kind];
  return text ? text(w.count ?? w.rects.length, w.chars ?? '') : w.message || w.kind;
}
