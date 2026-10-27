/** Position calculation for compositing the changed-region render (`DraftUpdate.region`) onto the page canvas (pure, contract D7). */
import type { RenderedPage } from '@pdf-editor/shared-types';
import { renderScale, type PageLayout } from './layout.js';

/** Top-left of the region bitmap on the canvas (device px). (0, 0) for a whole-page render. */
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
