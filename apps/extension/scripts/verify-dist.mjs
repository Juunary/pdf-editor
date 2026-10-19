// 빌드 산출물 검증.
// - MuPDF wasm 이 dist 에 원본과 동일한 바이트로 1개 들어갔는지
// - (M3) 한글 폴백 폰트 TTF 가 dist 에 원본과 동일한 바이트로 1개 있고 Worker 청크가 그 파일을 가리키는지
// - (M3) reflow 가 harfbuzzjs 를 import 하면 harfbuzz wasm 이 원본과 동일한 바이트로 1개 들어갔는지,
//   harfbuzz 코드가 Worker 청크에만 있는지(reflow 연결 전에는 건너뛴다)
// - manifest 의 M0 필수 항목(CSP, mime_types_handler + can_embed, DNR 권한, 최소 버전)
// - MuPDF 코드가 Worker 청크에만 있는지(뷰어 메인 스레드·서비스 워커에 섞이지 않음)
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

// wasm: 해시로 식별한다. MuPDF 는 항상 1개, harfbuzz 는 reflow 가 harfbuzzjs 를 import 할 때 1개, 그 밖의 wasm 은 오류.
const wasm = files.filter((f) => f.endsWith('.wasm'));
const mupdfSha = sha256(join(mupdfDir, 'mupdf-wasm.wasm'));
const repoRoot = join(root, '..', '..');
const harfbuzzWasmPath = join(
  repoRoot,
  'packages/reflow/node_modules/harfbuzzjs/dist/harfbuzz.wasm',
);
const harfbuzzSha = existsSync(harfbuzzWasmPath) ? sha256(harfbuzzWasmPath) : null;
const reflowSrc = join(repoRoot, 'packages/reflow/src');
const reflowUsesHarfbuzz =
  existsSync(reflowSrc) &&
  walk(reflowSrc)
    .filter((f) => /\.[cm]?tsx?$/.test(f))
    .some((f) => /['"]harfbuzzjs(\/[^'"]*)?['"]/.test(readFileSync(f, 'utf8')));
const wasmBySha = new Map(wasm.map((f) => [sha256(f), f]));
const mupdfWasm = wasmBySha.get(mupdfSha) ?? null;
const harfbuzzWasm = harfbuzzSha ? (wasmBySha.get(harfbuzzSha) ?? null) : null;
if (!mupdfWasm) errors.push('MuPDF wasm 해시 일치 파일 없음');
if (reflowUsesHarfbuzz) {
  if (!harfbuzzSha) errors.push('harfbuzzjs wasm 원본을 찾지 못함(reflow 의존성 미설치)');
  else if (!harfbuzzWasm) errors.push('reflow 가 harfbuzzjs 를 쓰는데 dist 에 harfbuzz wasm 없음');
}
const expectedWasm = 1 + (reflowUsesHarfbuzz ? 1 : 0);
if (wasm.length !== expectedWasm) {
  errors.push(`wasm 자산 ${wasm.length}개 (기대 ${expectedWasm}): ${wasm.map(rel).join(', ')}`);
}
// 폴백 폰트(M3): 원본과 같은 바이트 1개.
const fontSource = join(repoRoot, 'assets/fonts/NotoSansKR-Regular-subset.ttf');
const fontSha = sha256(fontSource);
const fonts = files.filter((f) => f.endsWith('.ttf'));
if (fonts.length !== 1)
  errors.push(`폰트 자산 ${fonts.length}개 (기대 1): ${fonts.map(rel).join(', ')}`);
else if (sha256(fonts[0]) !== fontSha) errors.push(`폴백 폰트 해시 불일치: ${rel(fonts[0])}`);

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

// 폴백 폰트는 Worker 진입 청크가 참조해야 하고, harfbuzz 코드는 메인 스레드·서비스 워커에 섞이지 않아야 한다.
const pdfWorkerEntries = jsFiles.filter((f) => /assets\/pdf-worker-[^/]*\.js$/.test(f));
if (pdfWorkerEntries.length !== 1) {
  errors.push(`Worker 진입 청크 ${pdfWorkerEntries.length}개 (기대 1)`);
} else if (fonts.length === 1) {
  const fontName = rel(fonts[0]).replace(/^assets\//, '');
  if (!readFileSync(pdfWorkerEntries[0], 'utf8').includes(fontName)) {
    errors.push(`Worker 진입 청크가 폴백 폰트(${fontName})를 가리키지 않음`);
  }
}
const HARFBUZZ_MARKER = 'hb_shape';
const jsWithHarfbuzz = jsFiles
  .filter((f) => readFileSync(f, 'utf8').includes(HARFBUZZ_MARKER))
  .map(rel);
const mainThreadHarfbuzz = jsWithHarfbuzz.filter(
  (f) => f === 'background.js' || /^assets\/viewer-/.test(f),
);
if (mainThreadHarfbuzz.length > 0) {
  errors.push(`메인 스레드·서비스 워커에 harfbuzz 포함: ${mainThreadHarfbuzz.join(', ')}`);
}
if (reflowUsesHarfbuzz && jsWithHarfbuzz.length === 0) {
  errors.push('reflow 가 harfbuzzjs 를 쓰는데 Worker 청크에 harfbuzz 코드 없음');
}

if (errors.length > 0) {
  console.error(`[verify-dist] 실패\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `[verify-dist] OK: ${rel(mupdfWasm)} (${statSync(mupdfWasm).size} B, sha256 ${mupdfSha.slice(0, 12)}…), MuPDF 청크 ${jsWithMupdf[0]}`,
);
console.log(
  `[verify-dist] 폴백 폰트 ${rel(fonts[0])} (${statSync(fonts[0]).size} B, sha256 ${fontSha.slice(0, 12)}…)`,
);
console.log(
  harfbuzzWasm
    ? `[verify-dist] harfbuzz wasm ${rel(harfbuzzWasm)} (${statSync(harfbuzzWasm).size} B, sha256 ${harfbuzzSha.slice(0, 12)}…), harfbuzz 청크 ${jsWithHarfbuzz.join(', ')}`
    : '[verify-dist] SKIP harfbuzz: reflow 가 아직 harfbuzzjs 를 import 하지 않음(S2 머지 후 자동으로 검사한다)',
);
