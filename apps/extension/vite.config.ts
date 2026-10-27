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

// Build kinds (contract D6, D7). The default dev build goes to dist/ (includes diagnostics, keeps the Chrome 128+ DNR fallback; for development, e2e and legacy use).
// PDF_EDITOR_BUILD=store builds the Web Store variant (Chrome 151+, no DNR, host permissions or WAR) into out/release/build
// (set by `pnpm package`). Store source maps are hidden (no sourceMappingURL in the bundle) and package splits the .map files out.
const kind: BuildKind = process.env.PDF_EDITOR_BUILD === 'store' ? 'store' : 'dev';

/**
 * Builds the manifest per build kind. The version comes from a single place, package.json.
 * The same step injects `<html data-build>` so that CSS can hide the diagnostics UI in the store build only.
 * The store build does not produce the bench page (D6), so its link (`#open-bench`) is removed too, along with the save menu's downloads save (M0 diagnostics,
 * user request 2026-10-22).
 * Name/description localization (`_locales/<lang>/messages.json`, user decision 2026-10-26) is also emitted here. Dev builds append
 * " (dev)" to the name (`buildLocaleMessages`).
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

// MV3 extension build. Output goes to dist/, the target of Chrome "Load unpacked".
// - viewer.html: viewer (shared by the regular page and the MIME handler)
// - bench.html: M5 benchmark measurement page (diagnostic feature, docs/m5-perf.md). Included in dev builds only (excluded from the store build, D6)
// - background.js: service worker (fixed file name, referenced from the manifest)
// - MuPDF WASM: the Worker bundle references it via `new URL('mupdf-wasm.wasm', import.meta.url)` → emitted as an asset
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
    // Do not inline the wasm (about 10MB) or fonts as data URLs.
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
