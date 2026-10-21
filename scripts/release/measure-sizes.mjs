// 번들 자산(WASM·폰트·JS·CSS)의 크기를 원본·gzip·brotli 로 잰다(계약 4.3). brotli 는 Node zlib 로 계산한다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const KINDS = { '.wasm': 'wasm', '.ttf': 'font', '.js': 'js', '.css': 'css' };

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** @returns {{ file: string, kind: string, raw: number, gzip: number, brotli: number }[]} 큰 순 */
export function measureAssets(dir) {
  const rows = [];
  for (const file of walk(dir)) {
    const kind = KINDS[file.slice(file.lastIndexOf('.'))];
    if (!kind) continue;
    const buf = readFileSync(file);
    rows.push({
      file: relative(dir, file),
      kind,
      raw: buf.length,
      gzip: gzipSync(buf, { level: 9 }).length,
      brotli: brotliCompressSync(buf, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 11,
          [constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
        },
      }).length,
    });
  }
  return rows.sort((a, b) => b.raw - a.raw);
}
