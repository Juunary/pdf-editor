import type { ViewerController } from '../controller.js';
import { useViewerState } from '../hooks.js';
import { navDisabled } from '../page-nav.js';

interface Props {
  controller: ViewerController;
  dir: -1 | 1;
}

/**
 * Previous/next page arrows at the left and right edges of the page. Placed outside the page area (in the margin slots) so they do not cover the text layer or overlays,
 * and only the buttons receive pointer events. In a narrow window with no room for side slots, the slots shrink to width 0 and the buttons float overlapping the page edges
 * (mount's `data-pe-arrows`, `pageArrowLayout` in page-nav.ts).
 * For page navigation, the controller commits the edit draft first. No shortcuts are defined (they would conflict with caret movement).
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
