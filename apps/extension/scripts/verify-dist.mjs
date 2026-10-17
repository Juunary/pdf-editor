// 빌드 산출물 검증.
// - MuPDF wasm 이 dist 에 원본과 동일한 바이트로 1개 들어갔는지
// - manifest 의 M0 필수 항목(CSP, mime_types_handler + can_embed, DNR 권한, 최소 버전)
// - MuPDF 코드가 Worker 청크에만 있는지(뷰어 메인 스레드·서비스 워커에 섞이지 않음)
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
const rel = (p) => relative(dist, p);

const wasm = files.filter((f) => f.endsWith('.wasm'));
const expected = sha256(join(mupdfDir, 'mupdf-wasm.wasm'));
if (wasm.length !== 1) errors.push(`wasm 자산 개수 ${wasm.length} (기대 1)`);
else if (sha256(wasm[0]) !== expected) errors.push(`wasm 해시 불일치: ${rel(wasm[0])}`);

for (const required of ['viewer.html', 'background.js', 'manifest.json']) {
  if (!files.includes(join(dist, required))) errors.push(`누락: ${required}`);
}

if (files.includes(join(dist, 'manifest.json'))) {
  const m = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
  const csp = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";
  if (m.manifest_version !== 3) errors.push('manifest_version != 3');
  if (m.content_security_policy?.extension_pages !== csp) errors.push('CSP 불일치');
  const handler = m.mime_types_handler?.['application/pdf'];
  if (handler?.handler_url !== 'viewer.html' || handler?.can_embed !== true) {
    errors.push('mime_types_handler(application/pdf, can_embed) 불일치');
  }
  if (!m.permissions?.includes('declarativeNetRequestWithHostAccess')) {
    errors.push('declarativeNetRequestWithHostAccess 권한 누락');
  }
  if (m.minimum_chrome_version !== '128') errors.push('minimum_chrome_version != 128');
  if (!files.includes(join(dist, m.background?.service_worker ?? ''))) {
    errors.push('background.service_worker 파일 없음');
  }
}

// MuPDF 는 Worker 가 동적 import 하는 청크 하나에만 있어야 한다.
const MUPDF_MARKER = '_wasm_init_context';
const jsFiles = files.filter((f) => f.endsWith('.js'));
const jsWithMupdf = jsFiles.filter((f) => readFileSync(f, 'utf8').includes(MUPDF_MARKER)).map(rel);
if (jsWithMupdf.length !== 1) {
  errors.push(`MuPDF 포함 청크 ${jsWithMupdf.length}개 (기대 1): ${jsWithMupdf.join(', ')}`);
}
const forbidden = jsFiles
  .map(rel)
  .filter((f) => f === 'background.js' || /^assets\/viewer-/.test(f))
  .filter((f) => jsWithMupdf.includes(f));
if (forbidden.length > 0)
  errors.push(`메인 스레드·서비스 워커에 MuPDF 포함: ${forbidden.join(', ')}`);

if (errors.length > 0) {
  console.error(`[verify-dist] 실패\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `[verify-dist] OK: ${rel(wasm[0])} (${statSync(wasm[0]).size} B, sha256 ${expected.slice(0, 12)}…), MuPDF 청크 ${jsWithMupdf[0]}`,
);
