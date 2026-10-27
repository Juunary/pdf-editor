/**
 * Layout result → PDF text operator serialization. Only for Identity-H fonts (2-byte CID = glyph id).
 * One text matrix is set per line; glyph spacing within a line is left to the font's /W widths.
 * Layout must therefore be computed with advances quantized to 1/1000 em, the same unit as /W.
 * Clip operators (W n) are not emitted (no automatic clipping, PLAN.md 1.3).
 */

export interface TextLine {
  /** Line-start baseline origin, PDF user space (pt, origin at bottom left). */
  x: number;
  y: number;
  gids: number[];
}

export interface TextBlock {
  fontResource: string;
  fontSize: number;
  /** DeviceRGB 0–1 */
  color: [number, number, number];
  lines: TextLine[];
}

export function formatNumber(n: number): string {
  const s = n.toFixed(3).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

export function glyphHex(gids: readonly number[]): string {
  return gids
    .map((g) => {
      if (!Number.isInteger(g) || g < 0 || g > 0xffff) throw new Error(`glyph id 범위 밖: ${g}`);
      return g.toString(16).padStart(4, '0');
    })
    .join('');
}

export function serializeTextBlock(block: TextBlock): string {
  const f = formatNumber;
  const out = ['q', 'BT', `/${block.fontResource} ${f(block.fontSize)} Tf`];
  out.push(`${block.color.map(f).join(' ')} rg`);
  for (const line of block.lines) {
    if (line.gids.length === 0) continue;
    out.push(`1 0 0 1 ${f(line.x)} ${f(line.y)} Tm`, `<${glyphHex(line.gids)}> Tj`);
  }
  out.push('ET', 'Q');
  return `${out.join('\n')}\n`;
}
