// Generate THIRD_PARTY_NOTICES.txt (docs/m5-contract.md D6).
// - JS packages: counts only node_modules packages that appear in the release build's source maps (`sources`) (bundle graph). Dev dependencies do not go into the bundle, so
//   they are not in the list.
// - WASM·fonts: not visible in the bundle graph, so the manual table in scripts/release/third-party-extra.json is used.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const EXTRA_JSON = join(here, 'third-party-extra.json');
const REPO_ROOT = join(here, '..', '..');
const LICENSE_FILE = /^(licen[cs]e|notice|copying|copyright)([.-].*)?$/i;

const PNPM_SOURCE = /node_modules\/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)/;
const PLAIN_SOURCE = /node_modules\/((?:@[^/]+\/)?[^/]+)/;

/**
 * Collects third-party packages included in the bundle from the source map files.
 * @param {string[]} mapFiles
 * @param {string} [nodeModulesRoot] pnpm store root (default: repository root)
 * @returns {{ name: string, version: string, dir: string }[]} sorted by name
 */
export function collectBundlePackages(mapFiles, nodeModulesRoot = REPO_ROOT) {
  const found = new Map();
  for (const file of mapFiles) {
    const map = JSON.parse(readFileSync(file, 'utf8'));
    for (const source of map.sources ?? []) {
      let dir = null;
      const pnpm = PNPM_SOURCE.exec(source);
      if (pnpm) {
        dir = join(nodeModulesRoot, 'node_modules', '.pnpm', pnpm[1], 'node_modules', pnpm[2]);
      } else {
        const plain = PLAIN_SOURCE.exec(source);
        if (plain) dir = join(nodeModulesRoot, 'node_modules', plain[1]);
      }
      if (!dir || !existsSync(join(dir, 'package.json'))) continue;
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      found.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, dir, pkg });
    }
  }
  return [...found.values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
    .map(({ name, version, dir, pkg }) => ({
      name,
      version,
      dir,
      license: typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'UNKNOWN'),
      homepage:
        pkg.homepage ??
        (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url) ??
        null,
      author: typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name ?? null),
    }));
}

/** Text of the LICENSE·NOTICE·COPYING files in a package directory. */
export function readLicenseTexts(dir) {
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8').trimEnd() }));
}

const RULE = '='.repeat(78);
const THIN = '-'.repeat(78);

function section(title) {
  return `${RULE}\n${title}\n${RULE}\n`;
}

/**
 * @param {{ version: string, sourceUrl: string, packages: ReturnType<typeof collectBundlePackages>, extra?: any }} input
 */
export function renderNotices({ version, sourceUrl, packages, extra = loadExtra() }) {
  const out = [];
  out.push(`PDF Editor ${version} — 서드파티 고지 (THIRD PARTY NOTICES)\n`);
  out.push(
    `PDF Editor 는 AGPL-3.0-or-later 로 배포됩니다(LICENSE 파일). 소스: ${sourceUrl}\n` +
      '이 확장에는 아래 서드파티 소프트웨어가 포함되어 있습니다. 이 파일은 릴리스 빌드에서 자동으로 만들어집니다\n' +
      '(번들된 JS 패키지는 빌드 소스맵의 모듈 목록, WASM·폰트는 scripts/release/third-party-extra.json).\n',
  );

  out.push(section('1. 번들된 JavaScript 패키지'));
  for (const p of packages) {
    out.push(`${THIN}\n${p.name} ${p.version}\n라이선스: ${p.license}\n`);
    if (p.homepage) out.push(`출처: ${p.homepage}\n`);
    const texts = readLicenseTexts(p.dir);
    if (texts.length === 0)
      out.push('(패키지에 라이선스 파일 없음. package.json 의 license 필드 기준)\n');
    for (const t of texts) out.push(`\n[${t.file}]\n${t.text}\n`);
    out.push('');
  }

  out.push(section('2. WebAssembly·글꼴 (번들 그래프에 나타나지 않는 항목)'));
  out.push(`MuPDF WASM 빌드: ${extra.mupdfWasm.buildConfig}\n`);
  for (const e of extra.entries) {
    out.push(
      `${THIN}\n${e.name}\n버전: ${e.version}\n라이선스: ${e.license}\n출처: ${e.homepage}\n`,
    );
    if (e.copyright) out.push(`${e.copyright}\n`);
    if (e.notice) out.push(`${e.notice}\n`);
    for (const f of e.licenseFiles) {
      out.push(`\n[${f.split('/').pop()}]\n${readFileSync(join(here, f), 'utf8').trimEnd()}\n`);
    }
    out.push('');
  }
  return `${out.join('\n')}\n`;
}

export function loadExtra() {
  return JSON.parse(readFileSync(EXTRA_JSON, 'utf8'));
}
