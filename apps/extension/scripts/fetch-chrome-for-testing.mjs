// Downloads old Chrome for Testing (official distribution) versions into a cache outside the repository. For measuring the Chrome 128–150 DNR fallback path
// (docs/m0-corpus-recheck.md section 4, e2e/dnr-legacy.spec.ts).
//
//   node apps/extension/scripts/fetch-chrome-for-testing.mjs 128 140 150
//
// For each major version, picks the last linux64 build in the known-good-versions list. Output: the path of each executable (JSON).
// Cache location: $PDF_EDITOR_CFT_DIR or ~/.cache/pdf-editor/chrome-for-testing/<version>/
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const INDEX =
  'https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json';
const PLATFORM = 'linux64';
const root =
  process.env.PDF_EDITOR_CFT_DIR ?? join(homedir(), '.cache', 'pdf-editor', 'chrome-for-testing');

const majors = process.argv.slice(2).map(Number);
if (majors.length === 0 || majors.some((m) => !Number.isInteger(m))) {
  console.error('사용법: fetch-chrome-for-testing.mjs <주 버전>...');
  process.exit(2);
}

const index = await (await fetch(INDEX)).json();
const result = {};
for (const major of majors) {
  const builds = index.versions.filter(
    (v) =>
      Number(v.version.split('.')[0]) === major &&
      v.downloads?.chrome?.some((d) => d.platform === PLATFORM),
  );
  const build = builds.at(-1);
  if (!build) throw new Error(`Chrome for Testing ${major} ${PLATFORM} 빌드 없음`);
  const url = build.downloads.chrome.find((d) => d.platform === PLATFORM).url;
  const dir = join(root, build.version);
  const exe = join(dir, `chrome-${PLATFORM}`, 'chrome');
  if (!existsSync(exe)) {
    mkdirSync(dir, { recursive: true });
    const zip = join(dir, 'chrome.zip');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    writeFileSync(zip, new Uint8Array(await res.arrayBuffer()));
    const unzip = spawnSync('unzip', ['-q', '-o', zip, '-d', dir], { stdio: 'inherit' });
    if (unzip.status !== 0) throw new Error(`unzip 실패: ${zip}`);
    rmSync(zip);
  }
  result[major] = { version: build.version, url, executablePath: exe };
}
console.log(JSON.stringify(result, null, 2));
