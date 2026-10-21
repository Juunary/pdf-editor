// 확장 아이콘 생성(16·32·48·128 px). 단순 도형(파란 둥근 사각형 위 접힌 모서리 문서)만 쓰며 상표·글자는 없다.
// 외부 의존성 없이 래스터 → PNG(RGBA, zlib)로 쓴다. 결과는 저장소에 커밋한다.
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
const SS = 4; // 슈퍼샘플링 배수

const BLUE = [43, 108, 176];
const WHITE = [255, 255, 255];
const FOLD = [190, 210, 235];
const LINE = [43, 108, 176];

/** 단위 정사각형(0–1) 좌표의 색. 투명이면 null. */
function shade(x, y) {
  // 배경: 둥근 사각형(반지름 0.2)
  const r = 0.2;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null;
  // 문서: x 0.25–0.75, y 0.17–0.83, 오른쪽 위 모서리 접힘(0.17 변)
  const left = 0.25;
  const right = 0.75;
  const top = 0.17;
  const bottom = 0.83;
  const fold = 0.18;
  if (x >= left && x <= right && y >= top && y <= bottom) {
    const dx = x - (right - fold);
    const dy = y - top;
    if (dx > 0 && dy < fold) {
      // 접힌 영역: 대각선 아래쪽은 접힌 면, 위쪽은 배경
      return dx + (fold - dy) > fold ? (dy + (fold - dx) > fold ? FOLD : BLUE) : BLUE;
    }
    // 본문 줄 3개
    for (const ly of [0.46, 0.58, 0.7]) {
      if (Math.abs(y - ly) < 0.025 && x > 0.32 && x < (ly > 0.65 ? 0.58 : 0.68)) return LINE;
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
    raw[y * (stride + 1)] = 0; // 필터 없음
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 비트 깊이
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
