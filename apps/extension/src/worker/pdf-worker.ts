// 뷰어 소유 module Worker. MuPDF 와 문서 상태는 여기서만 산다(PLAN.md 5.2).
import { exposePdfWorker } from '@pdf-editor/core/worker';

// 한글 폴백 폰트(Noto Sans KR glyf 서브셋 TTF, 계약 5.7·D12). 번들러가 파일을 dist 자산으로 내보내고, Worker 가 처음
// 필요할 때(첫 getPageEditability·planParagraphEdit·beginParagraphEdit) 한 번 받는다. chrome.* 는 전용 Worker 에서
// 쓸 수 없으므로(docs/m3-viewer-ui.md 4절) 일반 fetch 만 쓴다.
const FALLBACK_FONT_URL = new URL(
  '../../../../assets/fonts/NotoSansKR-Regular-subset.ttf',
  import.meta.url,
);

async function loadFallbackFont(): Promise<Uint8Array> {
  const res = await fetch(FALLBACK_FONT_URL);
  if (!res.ok) throw new Error(`폴백 폰트를 받지 못했습니다: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// 벤치 전용 RPC(계약 D1 메모리 측정 시점, 사용자 결정 2026-10-21): dev 빌드에서만 더한다. 스토어 빌드는 이 분기가 상수로
// 접혀 `@pdf-editor/core/bench` 를 번들에 넣지 않는다(verify-dist --release 가 확인).
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
