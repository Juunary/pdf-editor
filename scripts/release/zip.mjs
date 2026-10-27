// Deterministic zip (fflate): entries are added in path order with a fixed timestamp, so the same input gives the same bytes.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// fflate is a dev dependency of apps/extension (not installed at the repository root).
const extRequire = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps', 'extension', 'package.json'),
);
const { zipSync } = extRequire('fflate');

/** Local time 2000-01-01 00:00:00 (zip stores local time, so this gives the same value regardless of time zone). */
export const ZIP_MTIME = new Date(2000, 0, 1, 0, 0, 0);

export function walkFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walkFiles(p) : [p];
  });
}

/** Builds zip bytes from all files under `dir` (paths use `/`, sorted). */
export function zipDirectory(dir) {
  const entries = walkFiles(dir)
    .map((file) => relative(dir, file).split(sep).join('/'))
    .sort();
  const input = {};
  for (const path of entries) {
    input[path] = [new Uint8Array(readFileSync(join(dir, path))), { mtime: ZIP_MTIME, level: 9 }];
  }
  return zipSync(input);
}
