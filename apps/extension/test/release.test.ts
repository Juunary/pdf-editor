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

describe('빌드 종류별 매니페스트(D7)', () => {
  it('dev: Chrome 128, DNR·호스트 권한·WAR 유지, 이름 표시, 버전은 package.json', () => {
    const m = buildManifest(base, 'dev', pkg.version);
    expect(m.version).toBe(pkg.version);
    expect(m.name).toBe('__MSG_appName__');
    expect(m.minimum_chrome_version).toBe('128');
    expect(m.permissions).toContain('declarativeNetRequestWithHostAccess');
    expect(m.host_permissions).toEqual(['<all_urls>']);
    expect(m.web_accessible_resources).toBeDefined();
  });

  it('store: Chrome 151, DNR·호스트 권한·WAR 제거, downloads 만 남김', () => {
    const m = buildManifest(base, 'store', pkg.version);
    expect(m.name).toBe('__MSG_appName__');
    expect(m.version).toBe('1.0.0');
    expect(m.minimum_chrome_version).toBe(STORE_MIN_CHROME);
    expect(m.permissions).toEqual(['downloads']);
    expect(m).not.toHaveProperty('host_permissions');
    expect(m).not.toHaveProperty('web_accessible_resources');
    expect(m).toHaveProperty('mime_types_handler');
    expect(JSON.stringify(m)).not.toContain('<all_urls>');
  });

  it('기준 매니페스트를 바꾸지 않고 알 수 없는 종류는 거부한다', () => {
    const before = JSON.stringify(base);
    buildManifest(base, 'store', '9.9.9');
    expect(JSON.stringify(base)).toBe(before);
    expect(() => buildManifest(base, 'x' as never, '1')).toThrow();
    expect(BUILD_KINDS).toEqual(['dev', 'store']);
  });

  it('아이콘 16·32·48·128 과 action.default_icon 을 가진다', () => {
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

  it('이름이 메시지 참조가 아니면 dev 는 매니페스트 이름에 (dev) 를 붙인다', () => {
    const m = buildManifest({ ...base, name: 'X' }, 'dev', '1.0.0');
    expect(m.name).toBe('X (dev)');
  });

  it('소스 링크는 버전 태그를 가리킨다', () => {
    expect(sourceUrl('1.0.0')).toBe('https://github.com/Juunary/pdf-editor/tree/v1.0.0');
  });
});

describe('이름·설명 현지화(사용자 결정 2026-10-26)', () => {
  const locales = readLocales(join(extRoot, '_locales'));
  const fields = ['name', 'description'] as const;

  it('기본 언어 en, 이름·설명·툴바 제목은 메시지 참조', () => {
    expect(base.default_locale).toBe(DEFAULT_LOCALE);
    expect(Object.keys(locales).sort()).toEqual([...LOCALES].sort());
    for (const f of fields) expect(base[f]).toMatch(/^__MSG_\w+__$/);
    expect((base.action as { default_title: string }).default_title).toMatch(/^__MSG_\w+__$/);
  });

  it('두 언어의 키가 같고 값이 있으며 설명은 132자 이하', () => {
    expect(Object.keys(locales.ko!).sort()).toEqual(Object.keys(locales.en!).sort());
    for (const [lang, messages] of Object.entries(locales)) {
      for (const f of fields) expect(resolveMessage(base[f], messages), lang).toBeTruthy();
      const description = resolveMessage(base.description, messages)!;
      expect([...description].length, lang).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
    }
    expect(resolveMessage(base.description, locales.en!)).not.toMatch(/[가-힣]/);
  });

  it('설명은 등록 자료(docs/store/listing.md) 요약과 같다', () => {
    const listing = readFileSync(join(repoRoot, 'docs/store/listing.md'), 'utf8');
    for (const messages of Object.values(locales)) {
      expect(listing).toContain(resolveMessage(base.description, messages)!);
    }
  });

  it('스토어는 두 언어 모두 "PDF Editor", 개발 빌드는 " (dev)" 를 붙인다', () => {
    const store = buildLocaleMessages(locales, 'store');
    const dev = buildLocaleMessages(locales, 'dev');
    for (const lang of LOCALES) {
      expect(resolveMessage(base.name, store[lang]!)).toBe('PDF Editor');
      expect(resolveMessage(base.name, dev[lang]!)).toBe('PDF Editor (dev)');
    }
    expect(resolveMessage(base.name, locales.en!)).toBe('PDF Editor'); // 원본은 그대로
    expect(() => buildLocaleMessages(locales, 'x' as never)).toThrow();
  });
});

describe('서드파티 고지', () => {
  function fakeMap(name: string, sources: string[]): string {
    const file = join(tmp, name);
    writeFileSync(file, JSON.stringify({ version: 3, sources }));
    return file;
  }

  it('소스맵의 node_modules 패키지만 센다(작업공간 코드·개발 의존성 제외)', () => {
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

  it('패키지 라이선스 본문·수동 표 항목(MuPDF thirdparty·harfbuzz·Noto)을 함께 쓴다', () => {
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

  it('수동 표가 가리키는 라이선스 파일이 모두 존재한다', () => {
    for (const e of loadExtra().entries) {
      for (const f of e.licenseFiles) {
        const path = join(repoRoot, 'scripts', 'release', f);
        expect(readFileSync(path, 'utf8').length, f).toBeGreaterThan(200);
      }
    }
  });
});

describe('OFL 예약 이름', () => {
  it("폴백 폰트의 글꼴 이름 항목에 'Source' 가 없다(저작권 고지 문자열에만 있음)", () => {
    const font = readFileSync(join(repoRoot, 'assets/fonts/NotoSansKR-Regular-subset.ttf'));
    expect(findReservedNameUse(font, 'Source')).toEqual([]);
    const family = readNameRecords(font).find((r) => r.nameID === 1 && r.platformID === 3);
    expect(family?.value).toBe('Noto Sans KR');
  });
});

describe('결정적 zip·크기 기록', () => {
  it('같은 입력은 같은 바이트, 항목은 경로순', () => {
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

  it('gzip·brotli 크기를 잰다', () => {
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
