import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BUILD_KINDS,
  DEFAULT_LOCALE,
  LOCALES,
  MAX_DESCRIPTION_CHARS,
  STORE_MIN_CHROME,
  buildLocaleMessages,
  buildManifest,
  readLocales,
  resolveMessage,
  sourceUrl,
} from '../scripts/manifest.mjs';
import { findReservedNameUse, readNameRecords } from '../../../scripts/release/font-names.mjs';
import {
  collectBundlePackages,
  loadExtra,
  renderNotices,
} from '../../../scripts/release/third-party-notices.mjs';
import { measureAssets } from '../../../scripts/release/measure-sizes.mjs';
import { zipDirectory } from '../../../scripts/release/zip.mjs';

const extRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(extRoot, '..', '..');
const base = JSON.parse(readFileSync(join(extRoot, 'manifest.json'), 'utf8')) as Record<
  string,
  unknown
>;
const pkg = JSON.parse(readFileSync(join(extRoot, 'package.json'), 'utf8')) as {
  version: string;
  devDependencies: Record<string, string>;
};

const tmp = mkdtempSync(join(tmpdir(), 'pdf-editor-release-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('manifest per build kind (D7)', () => {
  it('dev: Chrome 128, keeps DNR, host permissions and WAR, shows the name, version from package.json', () => {
    const m = buildManifest(base, 'dev', pkg.version);
    expect(m.version).toBe(pkg.version);
    expect(m.name).toBe('__MSG_appName__');
    expect(m.minimum_chrome_version).toBe('128');
    expect(m.permissions).toContain('declarativeNetRequestWithHostAccess');
    expect(m.host_permissions).toEqual(['<all_urls>']);
    expect(m.web_accessible_resources).toBeDefined();
  });

  it('store: Chrome 151, removes DNR, host permissions and WAR, keeps only downloads', () => {
    const m = buildManifest(base, 'store', pkg.version);
    expect(m.name).toBe('__MSG_appName__');
    expect(m.version).toBe(pkg.version);
    expect(m.minimum_chrome_version).toBe(STORE_MIN_CHROME);
    expect(m.permissions).toEqual(['downloads']);
    expect(m).not.toHaveProperty('host_permissions');
    expect(m).not.toHaveProperty('web_accessible_resources');
    expect(m).toHaveProperty('mime_types_handler');
    expect(JSON.stringify(m)).not.toContain('<all_urls>');
  });

  it('does not modify the base manifest and rejects unknown kinds', () => {
    const before = JSON.stringify(base);
    buildManifest(base, 'store', '9.9.9');
    expect(JSON.stringify(base)).toBe(before);
    expect(() => buildManifest(base, 'x' as never, '1')).toThrow();
    expect(BUILD_KINDS).toEqual(['dev', 'store']);
  });

  it('has icons 16, 32, 48, 128 and action.default_icon', () => {
    const m = buildManifest(base, 'store', '1.0.0') as {
      icons: Record<string, string>;
      action: { default_icon: Record<string, string> };
    };
    for (const size of ['16', '32', '48', '128']) {
      const png = readFileSync(join(extRoot, 'public', m.icons[size]!));
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect(png.readUInt32BE(16)).toBe(Number(size));
    }
    expect(Object.keys(m.action.default_icon)).toEqual(['16', '32']);
  });

  it('if the name is not a message reference, dev appends (dev) to the manifest name', () => {
    const m = buildManifest({ ...base, name: 'X' }, 'dev', '1.0.0');
    expect(m.name).toBe('X (dev)');
  });

  it('the source link points to the version tag', () => {
    expect(sourceUrl('1.0.0')).toBe('https://github.com/Juunary/pdf-editor/tree/v1.0.0');
  });
});

describe('name and description localization (user decision 2026-10-26)', () => {
  const locales = readLocales(join(extRoot, '_locales'));
  const fields = ['name', 'description'] as const;

  it('default language en; name, description and toolbar title are message references', () => {
    expect(base.default_locale).toBe(DEFAULT_LOCALE);
    expect(Object.keys(locales).sort()).toEqual([...LOCALES].sort());
    for (const f of fields) expect(base[f]).toMatch(/^__MSG_\w+__$/);
    expect((base.action as { default_title: string }).default_title).toMatch(/^__MSG_\w+__$/);
  });

  it('both languages have the same keys with values, and the description is at most 132 characters', () => {
    expect(Object.keys(locales.ko!).sort()).toEqual(Object.keys(locales.en!).sort());
    for (const [lang, messages] of Object.entries(locales)) {
      for (const f of fields) expect(resolveMessage(base[f], messages), lang).toBeTruthy();
      const description = resolveMessage(base.description, messages)!;
      expect([...description].length, lang).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
    }
    expect(resolveMessage(base.description, locales.en!)).not.toMatch(/[가-힣]/);
  });

  it('the description matches the summary in the listing material (docs/store/listing.md)', () => {
    const listing = readFileSync(join(repoRoot, 'docs/store/listing.md'), 'utf8');
    for (const messages of Object.values(locales)) {
      expect(listing).toContain(resolveMessage(base.description, messages)!);
    }
  });

  it('the store uses "PDF Editor" for both languages; the dev build appends " (dev)"', () => {
    const store = buildLocaleMessages(locales, 'store');
    const dev = buildLocaleMessages(locales, 'dev');
    for (const lang of LOCALES) {
      expect(resolveMessage(base.name, store[lang]!)).toBe('PDF Editor');
      expect(resolveMessage(base.name, dev[lang]!)).toBe('PDF Editor (dev)');
    }
    expect(resolveMessage(base.name, locales.en!)).toBe('PDF Editor'); // the original is unchanged
    expect(() => buildLocaleMessages(locales, 'x' as never)).toThrow();
  });
});

describe('third-party notices', () => {
  function fakeMap(name: string, sources: string[]): string {
    const file = join(tmp, name);
    writeFileSync(file, JSON.stringify({ version: 3, sources }));
    return file;
  }

  it('counts only node_modules packages from the source map (excludes workspace code and dev dependencies)', () => {
    const map = fakeMap('a.map', [
      '../../../../../../node_modules/.pnpm/preact@10.29.8/node_modules/preact/dist/preact.module.js',
      '../../../../../../node_modules/.pnpm/mupdf@1.28.1/node_modules/mupdf/dist/mupdf.js',
      '../../../src/viewer/main.ts',
      '../../../../../packages/core/src/index.ts',
    ]);
    const names = collectBundlePackages([map]).map((p) => `${p.name}@${p.version}`);
    expect(names).toEqual(['mupdf@1.28.1', 'preact@10.29.8']);
    for (const dev of Object.keys(pkg.devDependencies)) {
      expect(names.join(',')).not.toContain(`${dev}@`);
    }
  });

  it('uses the package license text and the manual table entries (MuPDF thirdparty, harfbuzz, Noto) together', () => {
    const map = fakeMap('b.map', [
      '../node_modules/.pnpm/preact@10.29.8/node_modules/preact/dist/preact.module.js',
    ]);
    const text = renderNotices({
      version: '1.0.0',
      sourceUrl: sourceUrl('1.0.0'),
      packages: collectBundlePackages([map]),
    });
    expect(text).toContain('preact 10.29.8');
    expect(text).toContain('MIT License');
    const extra = loadExtra();
    const names = extra.entries.map((e) => e.name).join('\n');
    for (const lib of [
      'FreeType',
      'HarfBuzz',
      'jbig2dec',
      'OpenJPEG',
      'lcms2',
      'libjpeg',
      'zlib',
      'Gumbo',
      'cmark-gfm',
      'Noto Sans KR',
    ]) {
      expect(names.toLowerCase()).toContain(lib.toLowerCase());
      expect(text.toLowerCase()).toContain(lib.toLowerCase());
    }
    expect(text).toContain('SIL OPEN FONT LICENSE');
    expect(text).toContain('/tree/v1.0.0');
  });

  it('every license file the manual table points to exists', () => {
    for (const e of loadExtra().entries) {
      for (const f of e.licenseFiles) {
        const path = join(repoRoot, 'scripts', 'release', f);
        expect(readFileSync(path, 'utf8').length, f).toBeGreaterThan(200);
      }
    }
  });
});

describe('OFL reserved name', () => {
  it("the fallback font name entries do not contain 'Source' (only in the copyright notice string)", () => {
    const font = readFileSync(join(repoRoot, 'assets/fonts/NotoSansKR-Regular-subset.ttf'));
    expect(findReservedNameUse(font, 'Source')).toEqual([]);
    const family = readNameRecords(font).find((r) => r.nameID === 1 && r.platformID === 3);
    expect(family?.value).toBe('Noto Sans KR');
  });
});

describe('deterministic zip and size record', () => {
  it('same input gives the same bytes, entries in path order', () => {
    const dir = join(tmp, 'zip-src');
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'b.txt'), 'bbb');
    writeFileSync(join(dir, 'a.txt'), 'aaa');
    writeFileSync(join(dir, 'assets', 'c.wasm'), Buffer.alloc(1000, 7));
    const a = Buffer.from(zipDirectory(dir));
    const b = Buffer.from(zipDirectory(dir));
    expect(a.equals(b)).toBe(true);
    expect(a.indexOf('a.txt')).toBeLessThan(a.indexOf('assets/c.wasm'));
    expect(a.indexOf('assets/c.wasm')).toBeLessThan(a.indexOf('b.txt'));
  });

  it('measures gzip and brotli sizes', () => {
    const dir = join(tmp, 'size-src');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'x.wasm'), Buffer.alloc(50_000, 1));
    writeFileSync(join(dir, 'ignored.txt'), 'x');
    const rows = measureAssets(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ file: 'x.wasm', kind: 'wasm', raw: 50_000 });
    expect(rows[0]!.gzip).toBeLessThan(1000);
    expect(rows[0]!.brotli).toBeLessThan(rows[0]!.gzip);
  });
});
