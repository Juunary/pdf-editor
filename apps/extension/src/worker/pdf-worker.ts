// Viewer-owned module Worker. MuPDF and document state live only here (PLAN.md 5.2).
import { exposePdfWorker } from '@pdf-editor/core/worker';

// Korean fallback font (Noto Sans KR glyf subset TTF, contract 5.7, D12). The bundler emits the file as a dist asset, and the Worker fetches it once, the first time
// it is needed (first getPageEditability, planParagraphEdit or beginParagraphEdit). chrome.* is unavailable in a dedicated Worker
// (docs/m3-viewer-ui.md section 4), so only plain fetch is used.
const FALLBACK_FONT_URL = new URL(
  '../../../../assets/fonts/NotoSansKR-Regular-subset.ttf',
  import.meta.url,
);

async function loadFallbackFont(): Promise<Uint8Array> {
  const res = await fetch(FALLBACK_FONT_URL);
  if (!res.ok) throw new Error(`폴백 폰트를 받지 못했습니다: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Bench-only RPC (contract D1 memory measurement point, user decision 2026-10-21): added in dev builds only. In the store build this branch folds to a constant
// and `@pdf-editor/core/bench` is not included in the bundle (verified by verify-dist --release).
const benchExtra: Record<string, (...args: never[]) => unknown> =
  __BUILD_KIND__ === 'dev'
    ? {
        benchProbeHeap: async (options?: { emptyStore?: boolean }) =>
          (await import('@pdf-editor/core/bench')).probeWasmHeap(options),
      }
    : {};

exposePdfWorker(
  self as unknown as Parameters<typeof exposePdfWorker>[0],
  { loadFallbackFont },
  benchExtra,
);
