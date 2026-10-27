// Measure the size of bundled assets (WASM·fonts·JS·CSS) raw, gzip, and brotli (contract 4.3). brotli is computed with Node zlib.
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

/** @returns {{ file: string, kind: string, raw: number, gzip: number, brotli: number }[]} sorted by size, largest first */
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
