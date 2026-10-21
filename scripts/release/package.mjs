// Web Store 업로드 패키지 생성(docs/m5-contract.md D6). `pnpm --filter @pdf-editor/extension package`.
//
//   out/release/build/    vite 스토어 빌드(PDF_EDITOR_BUILD=store, 소스맵 hidden)
//   out/release/staging/  build 에서 diag/·*.map 을 빼고 LICENSE·THIRD_PARTY_NOTICES.txt 를 더한 배포 내용
//   out/release/maps/     소스맵(릴리스 자산으로 따로 보관, zip 에 넣지 않음)
//   out/release/pdf-editor-<version>.zip, pdf-editor-<version>-sourcemaps.zip, sizes.json
//
// 의존 패키지(core·viewer-ui·shared-types)가 빌드돼 있어야 한다(turbo `build` 가 먼저 돈다).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceUrl } from '../../apps/extension/scripts/manifest.mjs';
import { measureAssets } from './measure-sizes.mjs';
import { collectBundlePackages, renderNotices } from './third-party-notices.mjs';
import { walkFiles, zipDirectory } from './zip.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const extRoot = join(repoRoot, 'apps', 'extension');
export const releaseDir = join(extRoot, 'out', 'release');
const version = JSON.parse(readFileSync(join(extRoot, 'package.json'), 'utf8')).version;

const buildDir = join(releaseDir, 'build');
const stagingDir = join(releaseDir, 'staging');
const mapsDir = join(releaseDir, 'maps');
const zipPath = join(releaseDir, `pdf-editor-${version}.zip`);
const mapsZipPath = join(releaseDir, `pdf-editor-${version}-sourcemaps.zip`);

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, {
    cwd: extRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 실패 (${r.status})`);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// 1) 스토어 빌드
rmSync(releaseDir, { recursive: true, force: true });
run('pnpm', ['exec', 'vite', 'build'], { PDF_EDITOR_BUILD: 'store' });

// 2) 스테이징: diag/·*.map 제외
mkdirSync(stagingDir, { recursive: true });
mkdirSync(mapsDir, { recursive: true });
const mapFiles = [];
cpSync(buildDir, stagingDir, {
  recursive: true,
  filter: (src) => {
    const rel = relative(buildDir, src);
    if (rel === 'diag' || rel.startsWith('diag/')) return false;
    if (src.endsWith('.map')) {
      mapFiles.push(src);
      return false;
    }
    return true;
  },
});
for (const map of mapFiles) {
  const dest = join(mapsDir, relative(buildDir, map));
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(map, dest);
}

// 3) 라이선스 파일: 저장소 LICENSE, 번들 그래프 기반 THIRD_PARTY_NOTICES.txt
cpSync(join(repoRoot, 'LICENSE'), join(stagingDir, 'LICENSE'));
const packages = collectBundlePackages(mapFiles);
writeFileSync(
  join(stagingDir, 'THIRD_PARTY_NOTICES.txt'),
  renderNotices({ version, sourceUrl: sourceUrl(version), packages }),
);

// 4) zip(결정적)
writeFileSync(zipPath, zipDirectory(stagingDir));
writeFileSync(mapsZipPath, zipDirectory(mapsDir));

// 5) 크기 기록(원본·gzip·brotli)
const sizes = measureAssets(stagingDir);
writeFileSync(join(releaseDir, 'sizes.json'), `${JSON.stringify({ version, sizes }, null, 2)}\n`);

// 6) 검증
run('node', ['scripts/verify-dist.mjs', '--release']);

const total = walkFiles(stagingDir).reduce((n, f) => n + statSync(f).size, 0);
console.log(
  `[package] ${relative(repoRoot, zipPath)} ${statSync(zipPath).size} B (sha256 ${sha256(readFileSync(zipPath))}), 스테이징 ${total} B, 번들 패키지 ${packages.map((p) => `${p.name}@${p.version}`).join(', ')}`,
);
if (!existsSync(zipPath)) process.exit(1);
