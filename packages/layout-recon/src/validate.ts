/**
 * 계약 2.1–2.4 불변식 검사. 위반 설명 목록을 돌려준다(빈 배열 = 통과). 시험·코퍼스 전수 점검·개발 모드 단언용.
 */
import type { PageLayout, PageModel } from '@pdf-editor/shared-types';

export function validateLayout(model: PageModel, layout: PageLayout): string[] {
  const v: string[] = [];
  const count = new Map<number, number>();
  const finite = (xs: readonly number[]) => xs.every((x) => Number.isFinite(x));
  layout.paragraphs.forEach((p, i) => {
    if (p.id !== i) v.push(`문단 id ${p.id} != ${i}`);
    for (const l of p.lines) count.set(l, (count.get(l) ?? 0) + 1);
    const chars = p.lines.flatMap((l) => model.lines[l]!.chars);
    if (chars.length !== p.chars.length || chars.some((c, k) => c !== p.chars[k]))
      v.push(`문단 ${i} chars`);
    let pos = 0;
    for (const r of p.styleRuns) {
      if (r.start !== pos || r.end <= r.start) v.push(`문단 ${i} 모양 구간 빈틈`);
      pos = r.end;
    }
    if (pos !== p.chars.length) v.push(`문단 ${i} 모양 구간 끝`);
    if (!finite(p.bbox) || (p.lineHeight !== null && !Number.isFinite(p.lineHeight)))
      v.push(`문단 ${i} 비유한 수`);
    if (p.column >= layout.columns.length) v.push(`문단 ${i} column 범위 밖`);
    if (p.figure !== null && !layout.figures[p.figure]?.labels.includes(i))
      v.push(`문단 ${i} figure 불일치`);
    if (p.table !== null && !layout.tables[p.table]?.cells.some((c) => c.paragraphs.includes(i)))
      v.push(`문단 ${i} table 불일치`);
  });
  model.lines.forEach((line, i) => {
    const visible = line.chars.some((c) => model.chars[c]!.text.trim() !== '');
    const n = count.get(i) ?? 0;
    if (visible && n !== 1) v.push(`줄 ${i} 소속 ${n}`);
    if (!visible && (n !== 0 || !layout.unassignedLines.includes(i))) v.push(`빈 줄 ${i}`);
  });
  const top = layout.readingOrder.map((r) => `${r.kind}:${r.id}`);
  if (new Set(top).size !== top.length) v.push('읽기 순서 중복');
  for (const p of layout.paragraphs)
    if (top.includes(`paragraph:${p.id}`) !== (p.table === null && p.figure === null))
      v.push(`문단 ${p.id} 최상위`);
  layout.tables.forEach((t, i) => {
    if (t.id !== i || !top.includes(`table:${i}`)) v.push(`표 ${i} id·순서`);
    const slots = new Set<string>();
    for (const c of t.cells) {
      const lines = c.paragraphs.flatMap((p) => layout.paragraphs[p]!.lines);
      if (lines.length !== c.lines.length || lines.some((l, k) => l !== c.lines[k]))
        v.push(`표 ${i} 셀 줄`);
      for (let r = c.row; r < c.row + c.rowSpan; r++)
        for (let q = c.col; q < c.col + c.colSpan; q++) {
          if (slots.has(`${r},${q}`)) v.push(`표 ${i} 셀 겹침`);
          slots.add(`${r},${q}`);
        }
    }
    if (slots.size !== t.rows * t.cols)
      v.push(`표 ${i} 격자 덮음 ${slots.size}/${t.rows * t.cols}`);
  });
  layout.figures.forEach((f, i) => {
    if (f.id !== i || !top.includes(`figure:${i}`)) v.push(`도형 ${i} id·순서`);
    for (const p of f.labels) if (layout.paragraphs[p]?.figure !== i) v.push(`도형 ${i} 라벨 ${p}`);
  });
  return v;
}
