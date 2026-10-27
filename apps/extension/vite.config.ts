import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import {
  buildLocaleMessages,
  buildManifest,
  readLocales,
  sourceUrl,
  type BuildKind,
} from './scripts/manifest.mjs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// 빌드 종류(계약 D6·D7). 기본 dev 는 dist/(진단 포함, Chrome 128+ DNR 폴백 유지, 개발·e2e·레거시 용).
// PDF_EDITOR_BUILD=store 는 Web Store 용(Chrome 151+, DNR·호스트 권한·WAR 없음)을 out/release/build 로 만든다
// (`pnpm package` 가 설정). 스토어 소스맵은 hidden(번들에 sourceMappingURL 없음)이고 package 가 .map 을 분리한다.
const kind: BuildKind = process.env.PDF_EDITOR_BUILD === 'store' ? 'store' : 'dev';

/**
 * 매니페스트를 빌드 종류별로 만든다. 버전은 package.json 한 곳에서 온다.
 * 같은 단계에서 `<html data-build>` 를 넣어 스토어 빌드에서만 진단 UI 를 CSS 로 숨길 수 있게 한다.
 * 스토어 빌드는 벤치 페이지를 만들지 않으므로(D6) 그 링크(`#open-bench`)도 빼고, 저장 메뉴의 downloads 저장(M0 진단,
 * 사용자 요청 2026-10-22)도 뺀다.
 * 이름·설명 현지화(`_locales/<lang>/messages.json`, 사용자 결정 2026-10-26)도 여기서 내보낸다. 개발 빌드는 이름에
 * " (dev)" 를 붙인다(`buildLocaleMessages`).
 */
function extensionBuild(): Plugin {
  return {
    name: 'pdf-editor-extension-build',
    transformIndexHtml: (html) => {
      const tagged = html.replace('<html ', `<html data-build="${kind}" `);
      return kind === 'store'
        ? tagged
            .replace(/\s*<a id="open-bench"[^>]*>[\s\S]*?<\/a>/, '')
            .replace(/\s*<button\s+id="save-downloads"[\s\S]*?<\/button>/, '')
        : tagged;
    },
    generateBundle() {
      const base = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: `${JSON.stringify(buildManifest(base, kind, pkg.version), null, 2)}\n`,
      });
      const locales = readLocales(fileURLToPath(new URL('./_locales', import.meta.url)));
      for (const [lang, messages] of Object.entries(buildLocaleMessages(locales, kind))) {
        this.emitFile({
          type: 'asset',
          fileName: `_locales/${lang}/messages.json`,
          source: `${JSON.stringify(messages, null, 2)}\n`,
        });
      }
    },
  };
}

// MV3 확장 빌드. 출력은 dist/ 이며 Chrome "압축해제된 확장 프로그램 로드" 대상이다.
// - viewer.html: 뷰어(일반 페이지·MIME handler 공용)
// - bench.html: M5 벤치마크 측정 페이지(진단 기능, docs/m5-perf.md). dev 빌드에만 넣는다(스토어 빌드 제외, D6)
// - background.js: 서비스 워커(파일명 고정, manifest 에서 참조)
// - MuPDF WASM: Worker 번들이 `new URL('mupdf-wasm.wasm', import.meta.url)` 로 참조 → 자산으로 출력
export default defineConfig({
  plugins: [extensionBuild()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_KIND__: JSON.stringify(kind),
    __SOURCE_URL__: JSON.stringify(sourceUrl(pkg.version)),
  },
  base: './',
  build: {
    outDir: kind === 'store' ? 'out/release/build' : 'dist',
    emptyOutDir: true,
    target: 'chrome128',
    // wasm(약 10MB)·폰트를 data URL 로 인라인하지 않는다.
    assetsInlineLimit: 0,
    modulePreload: false,
    sourcemap: kind === 'store' ? 'hidden' : true,
    rolldownOptions: {
      input: {
        viewer: 'viewer.html',
        ...(kind === 'dev' ? { bench: 'bench.html' } : {}),
        background: 'src/background.ts',
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
      },
    },
  },
  worker: {
    format: 'es',
  },
});
