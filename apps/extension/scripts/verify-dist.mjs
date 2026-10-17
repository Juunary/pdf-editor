// 빌드 산출물 검증: MuPDF wasm 이 dist 에 원본과 동일한 바이트로 들어갔는지 확인한다.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const require = createRequire(join(root, 'package.json'));
const mupdfDir = dirname(require.resolve('mupdf'));
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const errors = [];
const files = walk(dist);
const wasm = files.filter((f) => f.endsWith('.wasm'));
const expected = sha256(join(mupdfDir, 'mupdf-wasm.wasm'));
if (wasm.length !== 1) errors.push(`wasm 자산 개수 ${wasm.length} (기대 1)`);
else if (sha256(wasm[0]) !== expected) errors.push(`wasm 해시 불일치: ${relative(dist, wasm[0])}`);
for (const required of ['viewer.html', 'background.js']) {
  if (!files.includes(join(dist, required))) errors.push(`누락: ${required}`);
}

if (errors.length > 0) {
  console.error(`[verify-dist] 실패\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `[verify-dist] OK: ${relative(dist, wasm[0])} (${statSync(wasm[0]).size} B, sha256 ${expected.slice(0, 12)}…)`,
);
