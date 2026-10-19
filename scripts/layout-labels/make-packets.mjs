#!/usr/bin/env node
/**
 * 정확도 라벨 작업 묶음 생성(docs/m2-contract.md 4.1). 쪽마다 줄 상자·번호를 그린 PNG 와 줄 목록 TXT 를 만든다.
 * 줄 번호 = PageModel.lines 인덱스(core extractPageModel, includePathSegments: true).
 *
 *   pnpm build
 *   node scripts/layout-labels/make-packets.mjs <코퍼스 디렉터리> <출력 디렉터리> <문서 id>:<쪽,쪽,...> ...
 *   node scripts/layout-labels/make-packets.mjs --stats <코퍼스 디렉터리> <문서 id>:<쪽,...> ...
 *
 * 쪽 번호는 0부터. 출력: <출력>/<문서 id>-p<쪽 3자리>.png / .txt
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { extractPageModel, openPdf, renderPageRgba } from '../../packages/core/dist/index.js';
import {
  fingerprintText,
  lineFeatures,
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
