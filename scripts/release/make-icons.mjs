// Extension icon generation (16·32·48·128 px). Uses only simple shapes (a folded-corner document with a pencil over it, on a blue rounded square); no trademarks or text.
// Writes raster → PNG (RGBA, zlib) with no external dependencies. The result is committed to the repository.
//
//   node scripts/release/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const outDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'apps',
  'extension',
  'public',
  'icons',
);
export const ICON_SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling factor

const BLUE = [43, 108, 176];
const WHITE = [255, 255, 255];
const FOLD = [190, 210, 235];
const LINE = [43, 108, 176];
const LEAD = [45, 55, 72];
const WOOD = [250, 222, 176];
const BODY = [246, 173, 62];
const BODY_SHADE = [221, 140, 40];
const FERRULE = [203, 213, 224];
const ERASER = [240, 128, 128];

// Pencil: axis from the tip (lower left) to the eraser end (upper right), in unit-square coordinates
const TIP = [0.4, 0.8];
const END = [0.86, 0.34];
const HALF_W = 0.085; // half width of the body
const CONE = 0.17; // length of the sharpened cone
const LEAD_LEN = 0.06; // length of the graphite point
const ERASER_LEN = 0.11; // ferrule + eraser
const FERRULE_LEN = 0.04;
const GAP = 0.035; // background-coloured outline that separates the pencil from the document

function pencil(x, y) {
  const ax = END[0] - TIP[0];
  const ay = END[1] - TIP[1];
  const len = Math.hypot(ax, ay);
  const u = ((x - TIP[0]) * ax + (y - TIP[1]) * ay) / len;
  const v = ((x - TIP[0]) * -ay + (y - TIP[1]) * ax) / len;
  const halfAt = u < CONE ? (HALF_W * u) / CONE : HALF_W;
  if (u >= 0 && u <= len && Math.abs(v) <= halfAt) {
    if (u < LEAD_LEN) return LEAD;
    if (u < CONE) return WOOD;
    if (u > len - ERASER_LEN) return u < len - ERASER_LEN + FERRULE_LEN ? FERRULE : ERASER;
    return v < 0 ? BODY : BODY_SHADE;
  }
  if (u >= -GAP && u <= len + GAP && Math.abs(v) <= halfAt + GAP) return BLUE;
  return null;
}

/** Color at unit-square (0–1) coordinates. null if transparent. */
function shade(x, y) {
  // Background: rounded square (radius 0.2)
  const r = 0.2;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null;
  const p = pencil(x, y);
  if (p) return p;
  // Document: x 0.2–0.68, y 0.14–0.84, top-right corner folded (fold side 0.17)
  const left = 0.2;
  const right = 0.68;
  const top = 0.14;
  const bottom = 0.84;
  const fold = 0.17;
  if (x >= left && x <= right && y >= top && y <= bottom) {
    const dx = x - (right - fold);
    const dy = y - top;
    if (dx > 0 && dy < fold) {
      // Folded region: below the diagonal is the folded face, above it is the background
      return dy >= dx ? FOLD : BLUE;
    }
    // 3 body lines
    for (const ly of [0.42, 0.54, 0.66]) {
      if (Math.abs(y - ly) < 0.025 && x > 0.28 && x < (ly > 0.6 ? 0.46 : 0.6)) return LINE;
    }
    return WHITE;
  }
  return BLUE;
}

function raster(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((pxl + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += 1;
          }
        }
      }
      const o = (py * size + pxl) * 4;
      if (a > 0) {
        px[o] = Math.round(r / a);
        px[o + 1] = Math.round(g / a);
        px[o + 2] = Math.round(b / a);
        px[o + 3] = Math.round((255 * a) / (SS * SS));
      }
    }
  }
  return px;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePng(size) {
  const px = raster(size);
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // no filter
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(outDir, { recursive: true });
  for (const size of ICON_SIZES) {
    const file = join(outDir, `icon-${size}.png`);
    writeFileSync(file, encodePng(size));
    console.log(`[make-icons] ${file}`);
  }
}
