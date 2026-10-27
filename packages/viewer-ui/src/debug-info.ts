/**
 * Display info for the debug overlay (pure functions). Classifies characters using the linkPage result and turns the
 * source operation (SourceOp) of the character under the mouse into human-readable lines.
 */
import type {
  LinkStats,
  PageLinkage,
  PageModel,
  SourceMap,
  SourceOp,
} from '@pdf-editor/shared-types';

/** unmatched = match failed, limited = matched but with an edit-limit reason, matched = matched without limits. */
export type CharMatch = 'matched' | 'limited' | 'unmatched';

export function findOp(map: SourceMap, opId: number): SourceOp | null {
  if (opId < 0) return null;
  const direct = map.ops[opId];
  if (direct && direct.id === opId) return direct;
  return map.ops.find((op) => op.id === opId) ?? null;
}

export function classifyChar(linkage: PageLinkage, map: SourceMap, charIndex: number): CharMatch {
  const opId = linkage.charOp[charIndex] ?? -1;
  if (opId < 0) return 'unmatched';
  const op = findOp(map, opId);
  if (!op) return 'unmatched';
  return op.limits.length > 0 ? 'limited' : 'matched';
}

/** Overlay color (canvas fillStyle). */
export const MATCH_COLORS: Record<CharMatch, string> = {
  matched: 'rgba(0, 160, 60, 0.30)',
  limited: 'rgba(240, 160, 0, 0.40)',
  unmatched: 'rgba(220, 30, 30, 0.45)',
};

export const MATCH_LABELS: Record<CharMatch, string> = {
  matched: '매칭',
  limited: '매칭(편집 제한)',
  unmatched: '매칭 실패',
};

export function countMatches(
  model: PageModel,
  linkage: PageLinkage,
  map: SourceMap,
): Record<CharMatch, number> {
  const counts: Record<CharMatch, number> = { matched: 0, limited: 0, unmatched: 0 };
  for (let i = 0; i < model.chars.length; i++) counts[classifyChar(linkage, map, i)]++;
  return counts;
}

function percent(part: number, total: number): string {
  return total === 0 ? '-' : `${((part / total) * 100).toFixed(1)}%`;
}

/** One-line summary: character/shape match counts and the difference from the totals. */
export function linkSummary(stats: LinkStats): string {
  return [
    `글자 ${stats.matchedChars}/${stats.chars} (${percent(stats.matchedChars, stats.chars)})`,
    `도형 ${stats.matchedPaints}/${stats.paints} (${percent(stats.matchedPaints, stats.paints)})`,
    `최대 원점 오차 ${stats.maxOriginError.toFixed(2)}pt`,
    `글리프 수 차이 ${stats.glyphCountDelta}`,
    `도형 수 차이 ${stats.paintCountDelta}`,
  ].join(' · ');
}

function hex(code: number): string {
  return `0x${code.toString(16).toUpperCase()}`;
}

/** Description lines for the character under the mouse. A character that failed to match gets only that fact. */
export function describeChar(
  model: PageModel,
  linkage: PageLinkage,
  map: SourceMap,
  charIndex: number,
): string[] {
  const char = model.chars[charIndex];
  if (!char) return [];
  const font = model.fonts[char.fontId];
  const lines = [
    `글자 #${charIndex} "${char.text}" glyphSeq ${char.glyphSeq} · ${font?.name ?? `폰트 ${char.fontId}`} ${char.size.toFixed(1)}pt`,
  ];
  const opId = linkage.charOp[charIndex] ?? -1;
  const op = findOp(map, opId);
  if (!op) {
    lines.push('원본 연결: 실패 (unmatched)');
    return lines;
  }
  const stream =
    op.stream.contentsIndex === null
      ? `Form 스트림 obj ${op.stream.objectNumber}`
      : `페이지 Contents[${op.stream.contentsIndex}] obj ${op.stream.objectNumber}`;
  lines.push(`연산 #${op.id} ${op.op} (${op.kind})`);
  lines.push(`${stream} · 범위 ${op.range[0]}–${op.range[1]}`);
  if (op.formPath.length > 0) {
    lines.push(
      `Form 경로 ${op.formPath.map((s) => `${s.resourceName}(obj ${s.objectNumber})`).join(' > ')}`,
    );
  }
  const glyphIndex = linkage.charGlyph[charIndex] ?? -1;
  const glyph = glyphIndex >= 0 ? op.text?.glyphs[glyphIndex] : undefined;
  if (glyph) {
    const err = Math.hypot(glyph.origin[0] - char.origin[0], glyph.origin[1] - char.origin[1]);
    lines.push(
      `코드 ${hex(glyph.code)} · 바이트 ${glyph.byteRange[0]}–${glyph.byteRange[1]} · 원점 오차 ${err.toFixed(2)}pt`,
    );
  }
  lines.push(`제한: ${op.limits.length > 0 ? op.limits.join(', ') : '없음'}`);
  return lines;
}
