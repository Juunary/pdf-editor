import { render } from 'preact';
import type { ViewerController } from './controller.js';
import { DomInputBuffer } from './input-buffer.js';
import { Controls } from './components/Controls.js';
import { PageArrow } from './components/PageArrow.js';
import { PageSurface } from './components/PageSurface.js';
import { pageArrowLayout } from './page-nav.js';

export interface MountTargets {
  /** Controls in the toolbar (page navigation, find, layout and edit buttons) and the search bar. */
  controls: HTMLElement;
  /** Page surface (canvas and overlays). */
  pages: HTMLElement;
}

/** Wait (ms) until re-fitting after a window size or zoom (dpr) change. */
const RESIZE_DEBOUNCE_MS = 150;

/**
 * Mounts the viewer UI. The caller loads the first page with `controller.start()` (so that the caller
 * handles open failures). The returned function unmounts and cleans up the controller. The caller creates the controller (Worker connection, environment value injection).
 */
export function mountViewer(targets: MountTargets, controller: ViewerController): () => void {
  controller.edit?.setInputBuffer(new DomInputBuffer());
  render(<Controls controller={controller} />, targets.controls);
  render(
    <>
      <PageArrow controller={controller} dir={-1} />
      <PageSurface controller={controller} />
      <PageArrow controller={controller} dir={1} />
    </>,
    targets.pages,
  );

  // Decide the page-arrow slots (side slots or overlap over the page) from the document-area width (style.css `[data-pe-arrows]`). The host's fit-to-page
  // width is also decided by the same function (`pageArrowLayout`), so the two do not diverge.
  const pages = targets.pages;
  const syncArrows = () => {
    pages.dataset.peArrows = pageArrowLayout(pages.clientWidth).placement;
  };
  syncArrows();
  const arrowObserver =
    typeof ResizeObserver === 'function' ? new ResizeObserver(syncArrows) : null;
  arrowObserver?.observe(pages);

  let timer: ReturnType<typeof setTimeout> | null = null;
  const onResize = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void controller.refreshEnvironment();
    }, RESIZE_DEBOUNCE_MS);
  };
  window.addEventListener('resize', onResize);

  return () => {
    window.removeEventListener('resize', onResize);
    arrowObserver?.disconnect();
    delete pages.dataset.peArrows;
    if (timer !== null) clearTimeout(timer);
    controller.edit?.setInputBuffer(null);
    render(null, targets.controls);
    render(null, targets.pages);
    controller.dispose();
  };
}
