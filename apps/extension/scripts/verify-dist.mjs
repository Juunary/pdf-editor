// 빌드 산출물 검증.
// - MuPDF wasm 이 dist 에 원본과 동일한 바이트로 1개 들어갔는지
// - (M3) 한글 폴백 폰트 TTF 가 dist 에 원본과 동일한 바이트로 1개 있고 Worker 청크가 그 파일을 가리키는지
// - (M3) reflow 가 harfbuzzjs 를 import 하면 harfbuzz wasm 이 원본과 동일한 바이트로 1개 들어갔는지,
//   harfbuzz 코드가 Worker 청크에만 있는지(reflow 연결 전에는 건너뛴다)
// - manifest 의 M0 필수 항목(CSP, mime_types_handler + can_embed, DNR 권한, 최소 버전)
// - MuPDF 코드가 Worker 청크에만 있는지(뷰어 메인 스레드·서비스 워커에 섞이지 않음)
//
// `--release [out/release 디렉터리]`: Web Store 패키지(스테이징·zip) 검사(docs/m5-contract.md D6·D7).
// 위 공통 검사를 스테이징에 적용하고, 스토어 매니페스트(Chrome 151+, DNR·호스트 권한·WAR 없음), 개발 파일 부재
// (`diag/`·`*.map`·`sourceMappingURL`·벤치 페이지 `bench.html`·벤치 청크·downloads 저장 메뉴), 크기 상한, 버전 일치, 아이콘·LICENSE·THIRD_PARTY_NOTICES.txt·저작권 고지,
// OFL 예약 이름, zip 과 스테이징의 일치를 확인한다.
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STORE_MIN_CHROME } from './manifest.mjs';
import { findReservedNameUse } from '../../../scripts/release/font-names.mjs';
import { zipDirectory } from '../../../scripts/release/zip.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const releaseIdx = args.indexOf('--release');
const releaseMode = releaseIdx >= 0;
const releaseDir = releaseMode ? (args[releaseIdx + 1] ?? join(root, 'out', 'release')) : null;
const dist = releaseMode ? join(releaseDir, 'staging') : join(root, 'dist');
const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const MIB = 2 ** 20;
/** 계약 D6 자체 기준(Web Store zip 제한 값은 미확인). */
const MAX_UNPACKED_BYTES = 25 * MIB;
const MAX_ZIP_BYTES = 15 * MIB;
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
let releaseSummary = null;
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
  if (m.version !== pkgVersion) {
    errors.push(`manifest version(${m.version}) != package.json version(${pkgVersion})`);
  }
  if (!files.includes(join(dist, m.background?.service_worker ?? ''))) {
    errors.push('background.service_worker 파일 없음');
  }
  if (releaseMode) {
    // D7(a): 스토어 빌드는 mimeHandler 경로만 쓴다.
    if (m.name !== 'PDF Editor') errors.push(`name != PDF Editor: ${m.name}`);
    if (m.minimum_chrome_version !== STORE_MIN_CHROME) {
      errors.push(`minimum_chrome_version != ${STORE_MIN_CHROME}`);
    }
    const perms = m.permissions ?? [];
    if (perms.some((p) => /declarativeNetRequest/.test(p))) errors.push('DNR 권한이 남아 있음');
    if (perms.join(',') !== 'downloads') errors.push(`permissions != [downloads]: ${perms}`);
    if (m.host_permissions) errors.push('host_permissions 가 남아 있음');
    if (m.web_accessible_resources) errors.push('web_accessible_resources 가 남아 있음');
    for (const size of ['16', '32', '48', '128']) {
      const icon = m.icons?.[size];
      if (!icon || !files.includes(join(dist, icon))) errors.push(`icons.${size} 파일 없음`);
    }
    for (const size of ['16', '32']) {
      const icon = m.action?.default_icon?.[size];
      if (!icon || !files.includes(join(dist, icon)))
        errors.push(`action.default_icon.${size} 없음`);
    }
  } else {
    if (!m.permissions?.includes('declarativeNetRequestWithHostAccess')) {
      errors.push('declarativeNetRequestWithHostAccess 권한 누락');
    }
    if (m.minimum_chrome_version !== '128') errors.push('minimum_chrome_version != 128');
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

if (releaseMode) {
  // 개발 파일 부재
  const devFiles = files.map(rel).filter((f) => f.startsWith('diag/') || f.endsWith('.map'));
  if (devFiles.length > 0) errors.push(`개발 파일 포함: ${devFiles.join(', ')}`);
  const withMapRef = files
    .filter((f) => /\.(js|css|html)$/.test(f))
    .filter((f) => /sourceMappingURL/.test(readFileSync(f, 'utf8')))
    .map(rel);
  if (withMapRef.length > 0) errors.push(`sourceMappingURL 포함: ${withMapRef.join(', ')}`);
  // `?e2e` 시험 이음매는 코드에 남아 있어도 되지만, 개발 전용 진단 페이지 참조는 없어야 한다.
  for (const f of files.filter((f) => /\.(js|html)$/.test(f))) {
    if (/diag\/(m0-sample|embed-test|chrome-probe)/.test(readFileSync(f, 'utf8'))) {
      errors.push(`진단 자산 참조: ${rel(f)}`);
    }
  }

  // 벤치 측정 페이지(S2, docs/m5-perf.md)는 개발 빌드 전용이다(D6). 페이지·청크·링크 모두 없어야 한다.
  const benchFiles = files.map(rel).filter((f) => /(^|\/)bench[^/]*\.(html|js|css)$/.test(f));
  if (benchFiles.length > 0) errors.push(`벤치 파일 포함: ${benchFiles.join(', ')}`);
  for (const f of files.filter((f) => /\.(js|html)$/.test(f))) {
    if (/bench\.html|id="open-bench"/.test(readFileSync(f, 'utf8'))) {
      errors.push(`벤치 페이지 참조: ${rel(f)}`);
    }
  }
  // 저장 메뉴의 downloads 저장(M0 진단)은 개발 빌드 전용이다(사용자 요청 2026-10-22): 요소·처리 분기·스타일 모두 없어야 한다.
  for (const f of files.filter((f) => /\.(js|html|css)$/.test(f))) {
    if (/save-downloads/.test(readFileSync(f, 'utf8'))) {
      errors.push(`downloads 저장 메뉴 포함: ${rel(f)}`);
    }
  }
  const viewerHtmlPath = join(dist, 'viewer.html');
  if (existsSync(viewerHtmlPath) && !/id="save-menu"/.test(readFileSync(viewerHtmlPath, 'utf8'))) {
    errors.push('viewer.html 에 저장 메뉴(#save-menu) 없음');
  }
  // 벤치 전용 Worker RPC(WASM 사용 중 힙 측정, @pdf-editor/core/bench)도 스토어 빌드에 없어야 한다(D1 사용자 결정 2026-10-21).
  for (const f of files.filter((f) => f.endsWith('.js'))) {
    if (/benchProbeHeap|probeWasmHeap/.test(readFileSync(f, 'utf8'))) {
      errors.push(`벤치 전용 RPC 포함: ${rel(f)}`);
    }
  }

  // 필수 파일
  for (const required of ['LICENSE', 'THIRD_PARTY_NOTICES.txt']) {
    if (!files.includes(join(dist, required))) errors.push(`누락: ${required}`);
  }
  const noticesPath = join(dist, 'THIRD_PARTY_NOTICES.txt');
  if (existsSync(noticesPath)) {
    const notices = readFileSync(noticesPath, 'utf8');
    for (const needle of [
      'mupdf ',
      'harfbuzzjs',
      'preact',
      'comlink',
      'Noto Sans KR',
      '(URW)++',
      'Copyright',
    ]) {
      if (!notices.includes(needle)) errors.push(`THIRD_PARTY_NOTICES.txt 에 '${needle}' 없음`);
    }
    // 개발 의존성은 번들에 들어가지 않는다.
    const devDeps = new Set();
    for (const pj of [
      join(root, 'package.json'),
      join(repoRoot, 'package.json'),
      ...readdirSync(join(repoRoot, 'packages')).map((n) =>
        join(repoRoot, 'packages', n, 'package.json'),
      ),
    ]) {
      if (!existsSync(pj)) continue;
      const pkg = JSON.parse(readFileSync(pj, 'utf8'));
      for (const name of Object.keys(pkg.devDependencies ?? {})) devDeps.add(name);
    }
    const runtime = new Set(
      [join(root, 'package.json')].flatMap((pj) =>
        Object.keys(JSON.parse(readFileSync(pj, 'utf8')).dependencies ?? {}),
      ),
    );
    for (const name of devDeps) {
      if (runtime.has(name)) continue;
      if (new RegExp(`^${name.replace(/[/.]/g, '\\$&')} \\d`, 'm').test(notices)) {
        errors.push(`THIRD_PARTY_NOTICES.txt 에 개발 의존성 포함: ${name}`);
      }
    }
  }

  // OFL 예약 이름 'Source': 글꼴 이름 항목에 쓰이지 않아야 한다(저작권 고지 문자열 제외).
  if (fonts.length === 1) {
    const used = findReservedNameUse(readFileSync(fonts[0]), 'Source');
    if (used.length > 0) {
      errors.push(`폴백 폰트 name 표에 예약 이름 'Source': ${JSON.stringify(used)}`);
    }
  }

  // 크기 상한
  const unpacked = files.reduce((n, f) => n + statSync(f).size, 0);
  if (unpacked > MAX_UNPACKED_BYTES) {
    errors.push(`압축 전 합계 ${unpacked} B > ${MAX_UNPACKED_BYTES} B`);
  }
  const zipPath = join(releaseDir, `pdf-editor-${pkgVersion}.zip`);
  if (!existsSync(zipPath)) {
    errors.push(`zip 없음: ${zipPath}`);
  } else {
    const zipBytes = readFileSync(zipPath);
    if (zipBytes.length > MAX_ZIP_BYTES)
      errors.push(`zip ${zipBytes.length} B > ${MAX_ZIP_BYTES} B`);
    // zip = 스테이징(같은 파일·같은 바이트), 결정적 재생성
    const entries = unzipSync(new Uint8Array(zipBytes));
    const zipNames = Object.keys(entries).sort();
    const stagingNames = files.map(rel).sort();
    if (JSON.stringify(zipNames) !== JSON.stringify(stagingNames)) {
      errors.push('zip 항목이 스테이징과 다름');
    } else {
      for (const name of zipNames) {
        if (!Buffer.from(entries[name]).equals(readFileSync(join(dist, name)))) {
          errors.push(`zip 내용이 스테이징과 다름: ${name}`);
          break;
        }
      }
    }
    if (!Buffer.from(zipDirectory(dist)).equals(zipBytes)) {
      errors.push('같은 스테이징에서 zip 이 같은 바이트로 재생성되지 않음(결정성)');
    }
    releaseSummary = { zipBytes: zipBytes.length, unpacked };
  }
}

if (errors.length > 0) {
  console.error(`[verify-dist] 실패\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
if (releaseSummary) {
  console.log(
    `[verify-dist] release OK: 압축 전 ${releaseSummary.unpacked} B (상한 ${MAX_UNPACKED_BYTES}), zip ${releaseSummary.zipBytes} B (상한 ${MAX_ZIP_BYTES})`,
  );
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
