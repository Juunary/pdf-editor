/**
 * 표 검출 실데이터 점검(디버그 전용). TABLES_DEBUG_DIR(PageModel JSON 덤프 디렉터리)이 있을 때만 돈다.
 * 결과는 TABLES_DEBUG_OUT(기본 <DIR>/../tables-debug) 에 summary.json·summary.txt 로 쓴다.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PageModel } from '@pdf-editor/shared-types';
import { describe, expect, it } from 'vitest';
import { lineFeatures } from '../src/features.js';
import { summarizePaths } from '../src/paths.js';
import { detectTables } from '../src/tables.js';

const DIR = process.env.TABLES_DEBUG_DIR;

describe.skipIf(!DIR)('표 검출 실데이터 점검', () => {
  it('덤프 쪽마다 표를 찾아 요약을 쓴다', () => {
    const dir = DIR!;
    const out = process.env.TABLES_DEBUG_OUT ?? path.join(dir, '..', 'tables-debug');
    fs.mkdirSync(out, { recursive: true });
    const only = process.env.TABLES_DEBUG_ONLY?.split(',');
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .filter((f) => !only || only.some((o) => f.startsWith(o)))
      .sort();
    const summary: Record<string, unknown> = {};
    const txt: string[] = [];
    for (const f of files) {
      const name = f.replace(/\.json$/u, '');
      const model = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as PageModel;
      const feats = lineFeatures(model).filter((l) => l.horizontal);
      const ps = summarizePaths(model);
      const t0 = performance.now();
      const tables = detectTables(model, feats, ps);
      const ms = performance.now() - t0;
      const text = new Map(feats.map((l) => [l.index, l.text]));
      summary[name] = {
        ms,
        rules: ps.rules.length,
        boxes: ps.boxes.length,
        lines: feats.length,
        tables,
      };
      txt.push(
        `## ${name}  tables=${tables.length}  ${ms.toFixed(1)}ms  rules=${ps.rules.length} boxes=${ps.boxes.length} lines=${feats.length}`,
      );
      tables.forEach((t, i) => {
        const rows = t.rowBounds.length - 1;
        const cols = t.colBounds.length - 1;
        const n = t.cells.reduce((s, c) => s + c.lines.length, 0);
        txt.push(
          `  T${i} ${t.strategy} ${rows}x${cols} bbox=${t.bbox.map((v) => v.toFixed(0)).join(',')} lines=${n} merged=${t.cells.filter((c) => c.rowSpan > 1 || c.colSpan > 1).length}`,
        );
        for (let r = 0; r < Math.min(rows, 40); r++) {
          const cells = t.cells.filter((c) => c.row === r);
          txt.push(
            `    r${r}: ${cells
              .map(
                (c) =>
                  `[${c.lines.map((k) => text.get(k)).join(' / ')}]${c.colSpan > 1 ? `x${c.colSpan}` : ''}`,
              )
              .join(' ')}`,
          );
        }
      });
    }
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary));
    fs.writeFileSync(path.join(out, 'summary.txt'), txt.join('\n'));
    expect(files.length).toBeGreaterThan(0);
  });
});
