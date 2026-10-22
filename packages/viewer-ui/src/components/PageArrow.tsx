import type { ViewerController } from '../controller.js';
import { useViewerState } from '../hooks.js';
import { navDisabled } from '../page-nav.js';

interface Props {
  controller: ViewerController;
  dir: -1 | 1;
}

/**
 * 페이지 좌우 가장자리의 이전·다음 쪽 화살표. 쪽 영역 바깥(여백 칸)에 놓아 텍스트 층·오버레이를 가리지 않으며,
 * 포인터는 버튼만 받는다. 쪽이 문서 영역보다 넓어 가로로 넘치면 칸이 문서 영역 가장자리에 붙는다(style.css).
 * 쪽 이동은 컨트롤러가 편집 초안을 먼저 커밋한다. 단축키는 두지 않는다(캐럿 이동과 충돌).
 */
export function PageArrow({ controller, dir }: Props) {
  const state = useViewerState(controller);
  const t = controller.strings;
  const off = navDisabled(state.pageIndex, state.pageCount);
  const prev = dir < 0;
  const label = prev ? t.prevPage : t.nextPage;
  return (
    <div class={`pe-arrow-slot ${prev ? 'pe-arrow-slot-prev' : 'pe-arrow-slot-next'}`}>
      <button
        id={prev ? 'pe-arrow-prev' : 'pe-arrow-next'}
        type="button"
        class="pe-arrow"
        title={label}
        aria-label={label}
        disabled={prev ? off.prev : off.next}
        onClick={() => void (prev ? controller.prevPage() : controller.nextPage())}
      >
        <svg
          viewBox="0 0 24 24"
          width="30"
          height="30"
          fill="none"
          stroke="currentColor"
          stroke-width="2.75"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d={prev ? 'M15 4.5 7.5 12l7.5 7.5' : 'M9 4.5l7.5 7.5L9 19.5'} />
        </svg>
      </button>
    </div>
  );
}
