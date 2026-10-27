#!/usr/bin/env node
/**
 * Generates accuracy-label work packets (docs/m2-contract.md 4.1). Per page, makes a PNG with line boxes·numbers drawn and a TXT line list.
 * Line number = PageModel.lines index (core extractPageModel, includePathSegments: true).
 *
 *   pnpm build
 *   node scripts/layout-labels/make-packets.mjs <corpus directory> <output directory> <doc id>:<page,page,...> ...
 *   node scripts/layout-labels/make-packets.mjs --stats <corpus directory> <doc id>:<page,...> ...
 *   node scripts/layout-labels/make-packets.mjs --layout <corpus directory> <output directory> <doc id>:<page,...> ...
 *
 * --layout: draws the reconstruction result (reconstructPage) instead of lines. Flow paragraph boxes (color by role) and top-level reading-order numbers,
 * tables (cyan, grid), shapes (yellow). Output <doc id>-p<page>-layout.png. For failure analysis (not ground truth).
 *
 * Page numbers are 0-based. Output: <output>/<doc id>-p<page, 3 digits>.png / .txt
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { extractPageModel, openPdf, renderPageRgba } from '../../packages/core/dist/index.js';
import {
  fingerprintText,
  lineFeatures,
  reconstructPage,
  summarizePaths,
} from '../../packages/layout-recon/dist/index.js';

const SCALE = 2;
const COLORS = [
  [220, 30, 30],
  [30, 70, 220],
  [0, 150, 60],
  [190, 0, 190],
  [230, 120, 0],
  [0, 150, 160],
];
const DIGITS = [
  '111101101101111',
  '010110010010111',
  '111001111100111',
  '111001111001111',
  '101101111001001',
  '111100111001111',
  '111100111101111',
  '111001001001001',
  '111101111101111',
  '111101111001111',
];

function crc32(buf) {
  let c;
  const table = (crc32.t ??= Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1,
    );
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawer(img) {
  const { width, height, rgba } = img;
  const set = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = 255;
  };
  const rect = (x0, y0, x1, y1, color) => {
    for (let x = x0; x <= x1; x++) {
      set(x, y0, color);
      set(x, y1, color);
    }
    for (let y = y0; y <= y1; y++) {
      set(x0, y, color);
      set(x1, y, color);
    }
  };
  const fill = (x0, y0, x1, y1, color) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, color);
  };
  const number = (n, x, y, color) => {
    const s = String(n);
    const k = 2;
    const w = s.length * 4 * k + k;
    fill(x - 1, y - 1, x + w, y + 5 * k, [255, 255, 255]);
    [...s].forEach((d, i) => {
      const bits = DIGITS[Number(d)];
      for (let r = 0; r < 5; r++)
        for (let c = 0; c < 3; c++)
          if (bits[r * 3 + c] === '1')
            fill(
              x + i * 4 * k + c * k,
              y + r * k,
              x + i * 4 * k + c * k + k - 1,
              y + r * k + k - 1,
              color,
            );
    });
    return w;
  };
  return { rect, number };
}

function parseTargets(args) {
  return args.map((a) => {
    const [doc, pages] = a.split(':');
    return { doc, pages: pages.split(',').map(Number) };
  });
}

const argv = process.argv.slice(2);
const stats = argv[0] === '--stats';
if (stats) argv.shift();
const layoutMode = argv[0] === '--layout';
if (layoutMode) argv.shift();
const ROLE_RGB = {
  body: [30, 136, 229],
  heading: [216, 27, 96],
  'list-item': [46, 125, 50],
  caption: [239, 108, 0],
  header: [142, 36, 170],
  footer: [142, 36, 170],
  footnote: [109, 76, 65],
  other: [84, 110, 122],
};
const corpus = argv.shift();
const out = stats ? null : argv.shift();
if (out) fs.mkdirSync(out, { recursive: true });
for (const { doc: id, pages } of parseTargets(argv)) {
  const doc = openPdf(new Uint8Array(fs.readFileSync(path.join(corpus, `${id}.pdf`))));
  for (const pageIndex of pages) {
    if (pageIndex >= doc.countPages()) continue;
    const page = doc.loadPage(pageIndex);
    const model = extractPageModel(page, { pageIndex, includePathSegments: true });
    const feats = lineFeatures(model);
    const sha = createHash('sha256').update(fingerprintText(model), 'utf8').digest('hex');
    if (stats) {
      const ps = summarizePaths(model);
      const visible = feats.filter((f) => f.text.trim() !== '').length;
      const oneLineBlocks = model.blocks.filter((b) => b.lines.length === 1).length;
      console.log(
        `${id}:${pageIndex} lines=${visible} blocks=${model.blocks.length} oneLine=${oneLineBlocks} rules=${ps.rules.length} boxes=${ps.boxes.length} shapes=${ps.shapes.length} images=${model.images.length} multiSeg=${feats.filter((f) => f.segments.length >= 3).length}`,
      );
      page.destroy();
      continue;
    }
    const img = renderPageRgba(page, SCALE);
    page.destroy();
    const d = drawer(img);
    const [bx0, by0] = model.bounds;
    const px = (r) => r.map((v, k) => Math.round((v - (k % 2 ? by0 : bx0)) * SCALE));
    if (layoutMode) {
      const layout = reconstructPage(model);
      for (const p of layout.paragraphs) {
        const [x0, y0, x1, y1] = px(p.bbox);
        d.rect(x0, y0, x1, y1, ROLE_RGB[p.role]);
        if (p.table === null && p.figure === null)
          d.rect(x0 + 1, y0 + 1, x1 - 1, y1 - 1, ROLE_RGB[p.role]);
      }
      for (const t of layout.tables) {
        const [x0, y0, x1, y1] = px(t.bbox);
        for (const k of [0, 1, 2]) d.rect(x0 - k, y0 - k, x1 + k, y1 + k, [0, 137, 123]);
        for (const y of t.rowBounds) d.rect(x0, px([0, y])[1], x1, px([0, y])[1], [0, 137, 123]);
        for (const x of t.colBounds) d.rect(px([x, 0])[0], y0, px([x, 0])[0], y1, [0, 137, 123]);
      }
      for (const f of layout.figures) {
        const [x0, y0, x1, y1] = px(f.bbox);
        for (const k of [0, 1, 2]) d.rect(x0 - k, y0 - k, x1 + k, y1 + k, [249, 168, 37]);
      }
      layout.readingOrder.forEach((ref, k) => {
        const box =
          ref.kind === 'paragraph'
            ? layout.paragraphs[ref.id].bbox
            : ref.kind === 'table'
              ? layout.tables[ref.id].bbox
              : layout.figures[ref.id].bbox;
        const [x0, y0] = px(box);
        const w = String(k + 1).length * 8 + 2;
        d.number(k + 1, x0 - w - 3 >= 0 ? x0 - w - 3 : x0 + 1, y0, [33, 33, 33]);
      });
      const name = `${id}-p${String(pageIndex).padStart(3, '0')}-layout`;
      fs.writeFileSync(path.join(out, `${name}.png`), png(img.width, img.height, img.rgba));
      console.log(
        `${name}: paragraphs=${layout.paragraphs.length} tables=${layout.tables.length} figures=${layout.figures.length} ${layout.reconMs.toFixed(1)}ms`,
      );
      continue;
    }
    const rows = [];
    feats.forEach((f, i) => {
      const color = COLORS[i % COLORS.length];
      const [x0, y0, x1, y1] = f.bbox;
      const px0 = Math.round((x0 - bx0) * SCALE);
      const py0 = Math.round((y0 - by0) * SCALE);
      const px1 = Math.round((x1 - bx0) * SCALE);
      const py1 = Math.round((y1 - by0) * SCALE);
      d.rect(px0, py0, px1, py1, color);
      const labelW = String(i).length * 8 + 2;
      d.number(i, px0 - labelW - 3 >= 0 ? px0 - labelW - 3 : px0 + 1, py0, color);
      const style = `${f.bold ? 'B' : '-'}${f.italic ? 'I' : '-'}${f.horizontal ? '' : ' ROT'}`;
      rows.push(
        `${i} | ${f.bbox.map((v) => v.toFixed(1)).join(',')} | ${f.size.toFixed(1)} | ${style} | ${f.text}`,
      );
    });
    const name = `${id}-p${String(pageIndex).padStart(3, '0')}`;
    fs.writeFileSync(path.join(out, `${name}.png`), png(img.width, img.height, img.rgba));
    const head = [
      `# doc=${id} pageIndex=${pageIndex} bounds=${model.bounds.map((v) => v.toFixed(1)).join(',')} lineCount=${model.lines.length} linesSha256=${sha}`,
      `# images: ${model.images.map((m) => m.bbox.map((v) => v.toFixed(0)).join(',')).join(' ; ') || 'none'}`,
      '# idx | x0,y0,x1,y1 (pt, page space) | size | bold/italic | text',
    ];
    fs.writeFileSync(path.join(out, `${name}.txt`), [...head, ...rows].join('\n') + '\n');
    console.log(`${name}: lines=${feats.length}`);
  }
  doc.destroy();
}
