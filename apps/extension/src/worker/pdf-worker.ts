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

exposePdfWorker(self as unknown as Parameters<typeof exposePdfWorker>[0], { loadFallbackFont });
