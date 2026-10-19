/** 변경 영역 렌더(`DraftUpdate.region`)를 쪽 캔버스에 합성하는 위치 계산(순수, 계약 D7). */
import type { RenderedPage } from '@pdf-editor/shared-types';
import { renderScale, type PageLayout } from './layout.js';

/** 영역 비트맵의 캔버스 좌상단(device px). 쪽 전체 렌더면 (0, 0). */
export function regionPlacement(
  region: RenderedPage,
  layout: PageLayout,
): { x: number; y: number } {
  if (!region.clip) return { x: 0, y: 0 };
  const scale = renderScale(layout.cssScale, layout.devicePixelRatio);
  return {
    x: Math.round((region.clip[0] - layout.origin[0]) * scale),
    y: Math.round((region.clip[1] - layout.origin[1]) * scale),
  };
}
