// Build the Web Store upload package (docs/m5-contract.md D6). `pnpm --filter @pdf-editor/extension package`.
//
//   out/release/build/    vite store build (PDF_EDITOR_BUILD=store, source maps hidden)
//   out/release/staging/  distribution contents: build without diag/·*.map, plus LICENSE·THIRD_PARTY_NOTICES.txt
//   out/release/maps/     source maps (kept separately as release assets, not put in the zip)
//   out/release/pdf-editor-<version>.zip, pdf-editor-<version>-sourcemaps.zip, sizes.json
//
// Dependent packages (core·viewer-ui·shared-types) must be built (turbo `build` runs first).
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

// 1) store build
rmSync(releaseDir, { recursive: true, force: true });
run('pnpm', ['exec', 'vite', 'build'], { PDF_EDITOR_BUILD: 'store' });

// 2) staging: exclude diag/·*.map
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

// 3) license files: repository LICENSE, THIRD_PARTY_NOTICES.txt based on the bundle graph
cpSync(join(repoRoot, 'LICENSE'), join(stagingDir, 'LICENSE'));
const packages = collectBundlePackages(mapFiles);
writeFileSync(
  join(stagingDir, 'THIRD_PARTY_NOTICES.txt'),
  renderNotices({ version, sourceUrl: sourceUrl(version), packages }),
);

// 4) zip (deterministic)
writeFileSync(zipPath, zipDirectory(stagingDir));
writeFileSync(mapsZipPath, zipDirectory(mapsDir));

// 5) record sizes (raw·gzip·brotli)
const sizes = measureAssets(stagingDir);
writeFileSync(join(releaseDir, 'sizes.json'), `${JSON.stringify({ version, sizes }, null, 2)}\n`);

// 6) verification
run('node', ['scripts/verify-dist.mjs', '--release']);

const total = walkFiles(stagingDir).reduce((n, f) => n + statSync(f).size, 0);
console.log(
  `[package] ${relative(repoRoot, zipPath)} ${statSync(zipPath).size} B (sha256 ${sha256(readFileSync(zipPath))}), 스테이징 ${total} B, 번들 패키지 ${packages.map((p) => `${p.name}@${p.version}`).join(', ')}`,
);
if (!existsSync(zipPath)) process.exit(1);
