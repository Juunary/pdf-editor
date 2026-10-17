/**
 * 배치 결과 → PDF 텍스트 연산자 직렬화. Identity-H(2바이트 CID = glyph id) 폰트 전용.
 * 줄 단위로 텍스트 행렬을 두고, 줄 안의 글리프 간격은 폰트 /W 폭에 맡긴다.
 * 따라서 배치는 /W 와 같은 1/1000 em 으로 양자화한 advance 로 계산해야 한다.
 * 클립 연산자(W n)는 내보내지 않는다(자동 클립 금지, PLAN.md 1.3).
 */

export interface TextLine {
  /** 줄 시작 기준선 원점, PDF 사용자 공간(pt, 원점 좌하단). */
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
