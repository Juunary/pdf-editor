import { render } from 'preact';
import type { ViewerController } from './controller.js';
import { Controls } from './components/Controls.js';
import { PageArrow } from './components/PageArrow.js';
import { PageSurface } from './components/PageSurface.js';

export interface MountTargets {
  /** 툴바 안 컨트롤(페이지 이동·찾기·디버그 토글)과 검색창. */
  controls: HTMLElement;
  /** 페이지 표면(캔버스와 오버레이). */
  pages: HTMLElement;
}

/** 창 크기·확대/축소(dpr) 변화 후 다시 맞추기까지의 대기(ms). */
const RESIZE_DEBOUNCE_MS = 150;

/**
 * 뷰어 UI 를 마운트한다. 첫 페이지는 호출자가 `controller.start()` 로 불러온다(열기 실패 처리를 호출자가
 * 하도록). 반환 함수는 마운트를 해제하고 컨트롤러를 정리한다. 컨트롤러는 호출자가 만든다(Worker 연결·환경 값 주입).
 */
export function mountViewer(targets: MountTargets, controller: ViewerController): () => void {
  render(<Controls controller={controller} />, targets.controls);
  render(
    <>
      <PageArrow controller={controller} dir={-1} />
      <PageSurface controller={controller} />
      <PageArrow controller={controller} dir={1} />
    </>,
    targets.pages,
  );

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
    if (timer !== null) clearTimeout(timer);
    render(null, targets.controls);
    render(null, targets.pages);
    controller.dispose();
  };
}
