/** Debug (only when the environment variable LAYOUT_DEBUG_MODEL is set): writes the units, regions and paragraphs of one page to a file. */
import fs from 'node:fs';
import { describe, it } from 'vitest';
import type { PageModel } from '@pdf-editor/shared-types';
import { lineFeatures } from '../src/features.js';
import { bodySize, splitMargins, splitParagraphs, stackRegions } from '../src/flow.js';
import { reconstructPage } from '../src/reconstruct.js';
import { buildUnits, inlineImages } from '../src/units.js';

const FILE = process.env.LAYOUT_DEBUG_MODEL;
const OUT = process.env.LAYOUT_DEBUG_OUT ?? '/dev/null';

describe.skipIf(!FILE)('debug', () => {
  it('page dump', () => {
    const model = JSON.parse(fs.readFileSync(FILE!, 'utf8')) as PageModel;
    const feats = lineFeatures(model).filter((f) => f.text.trim() !== '' && f.horizontal);
    const units = buildUnits(model, feats, inlineImages(model, 10));
    const body = bodySize(units);
    const m = splitMargins(units, model.bounds, body);
    const out: string[] = [
      `body=${body} header=${m.header.map((u) => u.text.slice(0, 20) + '@' + u.bbox.map((v) => v.toFixed(0)).join(',')).join(' / ')} footer=${m.footer.length}`,
    ];
    const regions = stackRegions(m.body, []);
    regions.forEach((r, k) => {
      out.push(`R${k} ${r.bbox.map((v) => v.toFixed(0)).join(',')}`);
      const why: string[] = [];
      const ps = splitParagraphs(r, why);
      out.push(`  why: ${why.join(' ')}`);
      for (const p of ps)
        out.push(
          `  P ${p.map((u) => u.parts.map((x) => x.index).join('+')).join(' ')} | ${p[0]!.text.slice(0, 40)}`,
        );
    });
    const layout = reconstructPage(model);
    out.push('--- layout');
    for (const ref of layout.readingOrder) {
      if (ref.kind === 'paragraph') {
        const p = layout.paragraphs[ref.id]!;
        out.push(`P${p.id} ${p.role} c${p.column} [${p.lines.join(',')}] ${p.text.slice(0, 50)}`);
      } else out.push(`${ref.kind}${ref.id}`);
    }
    for (const f of layout.figures)
      out.push(
        `FIG${f.id} ${f.kind} ${f.bbox.map((v) => v.toFixed(0)).join(',')} paths=${f.paths.length} images=${f.images.length} labels=${f.labels.length}`,
      );
    for (const t of layout.tables)
      out.push(
        `TBL${t.id} ${t.strategy} ${t.bbox.map((v) => v.toFixed(0)).join(',')} ${t.rows}x${t.cols}`,
      );
    fs.writeFileSync(OUT, out.join('\n') + '\n');
  });
});
