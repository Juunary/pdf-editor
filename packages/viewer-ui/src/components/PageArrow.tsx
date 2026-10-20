import type { ViewerController } from '../controller.js';
import { useViewerState } from '../hooks.js';
import { navDisabled } from '../page-nav.js';

interface Props {
  controller: ViewerController;
  dir: -1 | 1;
}

/**
 * 페이지 좌우 가장자리의 이전·다음 쪽 화살표. 쪽 영역 바깥(여백 칸)에 놓아 텍스트 층·오버레이를 가리지 않으며,
 * 포인터는 버튼만 받는다. 쪽 이동은 컨트롤러가 편집 초안을 먼저 커밋한다. 단축키는 두지 않는다(캐럿 이동과 충돌).
 */
export function PageArrow({ controller, dir }: Props) {
  const state = useViewerState(controller);
  const off = navDisabled(state.pageIndex, state.pageCount);
  const prev = dir < 0;
  return (
    <div class="pe-arrow-slot">
      <button
        id={prev ? 'pe-arrow-prev' : 'pe-arrow-next'}
        type="button"
        class="pe-arrow"
        title={prev ? '이전 페이지' : '다음 페이지'}
        aria-label={prev ? '이전 페이지' : '다음 페이지'}
        disabled={prev ? off.prev : off.next}
        onClick={() => void (prev ? controller.prevPage() : controller.nextPage())}
      >
        {prev ? '‹' : '›'}
      </button>
    </div>
  );
}
