// Build output verification.
// - the MuPDF wasm is in dist exactly once, with bytes identical to the original
// - (M3) the Korean fallback font TTF is in dist exactly once with bytes identical to the original, and the Worker chunk points to that file
// - (M3) if reflow imports harfbuzzjs, the harfbuzz wasm is in exactly once with bytes identical to the original,
//   and harfbuzz code is only in the Worker chunk (skipped until reflow is wired up)
// - required M0 items in the manifest (CSP, mime_types_handler + can_embed, DNR permissions, minimum version)
// - name / description / toolbar title localization (user decision 2026-10-26): `default_locale` en, `__MSG_…__` references, values in `_locales/{en,ko}`
//   (name = PDF Editor, dev build adds " (dev)", description at most 132 characters)
// - MuPDF code is only in the Worker chunk (not mixed into the viewer main thread or service worker)
//
// `--release [out/release directory]`: checks the Web Store package (staging and zip) (docs/m5-contract.md D6, D7).
// Applies the common checks above to staging, and also checks the store manifest (Chrome 151+, no DNR, host permissions or WAR), absence of dev files
// (`diag/`, `*.map`, `sourceMappingURL`, the bench page `bench.html`, bench chunks, the downloads save menu), size limits, version match, icons, LICENSE, THIRD_PARTY_NOTICES.txt, copyright notices,
// the OFL reserved name, and that the zip matches staging (including `_locales`).
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LOCALE,
  DEV_NAME_SUFFIX,
  LOCALES,
  MAX_DESCRIPTION_CHARS,
  STORE_MIN_CHROME,
  STORE_NAME,
  messageKey,
  resolveMessage,
} from './manifest.mjs';
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
/** Contract D6 own limits (the Web Store zip limit values are unconfirmed). */
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

// wasm: identified by hash. MuPDF is always 1; harfbuzz is 1 when reflow imports harfbuzzjs; any other wasm is an error.
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
// Fallback font (M3): 1 file with the same bytes as the original.
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
  // Localization (user decision 2026-10-26): name, description and toolbar title are message references; values are in the per-language messages.json.
  if (m.default_locale !== DEFAULT_LOCALE) {
    errors.push(`default_locale != ${DEFAULT_LOCALE}: ${m.default_locale}`);
  }
  const localeDirs = existsSync(join(dist, '_locales'))
    ? readdirSync(join(dist, '_locales')).sort()
    : [];
  if (JSON.stringify(localeDirs) !== JSON.stringify([...LOCALES].sort())) {
    errors.push(`_locales 언어 ${localeDirs.join(',') || '없음'} (기대 ${LOCALES.join(',')})`);
  }
  const expectedName = releaseMode ? STORE_NAME : `${STORE_NAME}${DEV_NAME_SUFFIX}`;
  const localized = [
    ['name', m.name],
    ['description', m.description],
    ['action.default_title', m.action?.default_title],
  ];
  for (const [field, value] of localized) {
    if (messageKey(value) === null) errors.push(`${field} 가 __MSG_…__ 참조가 아님: ${value}`);
  }
  for (const lang of LOCALES) {
    const path = join(dist, '_locales', lang, 'messages.json');
    if (!existsSync(path)) {
      errors.push(`누락: _locales/${lang}/messages.json`);
      continue;
    }
    let messages;
    try {
      messages = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      errors.push(`_locales/${lang}/messages.json JSON 오류: ${e}`);
      continue;
    }
    for (const [field, value] of localized) {
      const text = resolveMessage(value, messages);
      if (!text || text.trim() === '') errors.push(`${lang}: ${field}(${value}) 값 없음`);
    }
    const name = resolveMessage(m.name, messages);
    if (name !== expectedName) errors.push(`${lang}: name != ${expectedName}: ${name}`);
    const description = resolveMessage(m.description, messages) ?? '';
    if ([...description].length > MAX_DESCRIPTION_CHARS) {
      errors.push(`${lang}: description ${[...description].length}자 > ${MAX_DESCRIPTION_CHARS}자`);
    }
  }
  if (releaseMode) {
    // D7(a): the store build uses only the mimeHandler path.
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

// MuPDF must be in exactly one chunk, the one the Worker dynamically imports.
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

// The fallback font must be referenced by the Worker entry chunk, and harfbuzz code must not be mixed into the main thread or service worker.
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
  // Absence of dev files
  const devFiles = files.map(rel).filter((f) => f.startsWith('diag/') || f.endsWith('.map'));
  if (devFiles.length > 0) errors.push(`개발 파일 포함: ${devFiles.join(', ')}`);
  const withMapRef = files
    .filter((f) => /\.(js|css|html)$/.test(f))
    .filter((f) => /sourceMappingURL/.test(readFileSync(f, 'utf8')))
    .map(rel);
  if (withMapRef.length > 0) errors.push(`sourceMappingURL 포함: ${withMapRef.join(', ')}`);
  // The `?e2e` test seam may remain in code, but there must be no references to the dev-only diagnostics page.
  for (const f of files.filter((f) => /\.(js|html)$/.test(f))) {
    if (/diag\/(m0-sample|embed-test|chrome-probe)/.test(readFileSync(f, 'utf8'))) {
      errors.push(`진단 자산 참조: ${rel(f)}`);
    }
  }

  // The bench measurement page (S2, docs/m5-perf.md) is dev-build only (D6). The page, chunks and links must all be absent.
  const benchFiles = files.map(rel).filter((f) => /(^|\/)bench[^/]*\.(html|js|css)$/.test(f));
  if (benchFiles.length > 0) errors.push(`벤치 파일 포함: ${benchFiles.join(', ')}`);
  for (const f of files.filter((f) => /\.(js|html)$/.test(f))) {
    if (/bench\.html|id="open-bench"/.test(readFileSync(f, 'utf8'))) {
      errors.push(`벤치 페이지 참조: ${rel(f)}`);
    }
  }
  // The save menu's downloads save (M0 diagnostics) is dev-build only (user request 2026-10-22): the element, handler branch and style must all be absent.
  for (const f of files.filter((f) => /\.(js|html|css)$/.test(f))) {
    if (/save-downloads/.test(readFileSync(f, 'utf8'))) {
      errors.push(`downloads 저장 메뉴 포함: ${rel(f)}`);
    }
  }
  const viewerHtmlPath = join(dist, 'viewer.html');
  if (existsSync(viewerHtmlPath) && !/id="save-menu"/.test(readFileSync(viewerHtmlPath, 'utf8'))) {
    errors.push('viewer.html 에 저장 메뉴(#save-menu) 없음');
  }
  // The bench-only Worker RPC (heap measurement during WASM use, @pdf-editor/core/bench) must also be absent from the store build (D1 user decision 2026-10-21).
  for (const f of files.filter((f) => f.endsWith('.js'))) {
    if (/benchProbeHeap|probeWasmHeap/.test(readFileSync(f, 'utf8'))) {
      errors.push(`벤치 전용 RPC 포함: ${rel(f)}`);
    }
  }

  // Required files
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
    // Dev dependencies do not go into the bundle.
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

  // OFL reserved name 'Source': must not be used in font name entries (excluding the copyright notice string).
  if (fonts.length === 1) {
    const used = findReservedNameUse(readFileSync(fonts[0]), 'Source');
    if (used.length > 0) {
      errors.push(`폴백 폰트 name 표에 예약 이름 'Source': ${JSON.stringify(used)}`);
    }
  }

  // Size limits
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
    // zip = staging (same files, same bytes), deterministic regeneration
    const entries = unzipSync(new Uint8Array(zipBytes));
    const zipNames = Object.keys(entries).sort();
    const stagingNames = files.map(rel).sort();
    for (const lang of LOCALES) {
      if (!zipNames.includes(`_locales/${lang}/messages.json`)) {
        errors.push(`zip 에 _locales/${lang}/messages.json 없음`);
      }
    }
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
