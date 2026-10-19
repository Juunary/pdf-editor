/**
 * PageModel → PageLayout(계약 docs/m2-contract.md 3절).
 */
import type { PageLayout, PageModel } from '@pdf-editor/shared-types';

export interface ReconOptions {
  /** ML 보조 후보(계약 3절 8단계). v1 기본 구현 없음. */
  plugins?: readonly LayoutPlugin[];
}

export interface RegionProposal {
  kind: 'table' | 'figure' | 'paragraph';
  bbox: [number, number, number, number];
  score: number;
}

/** ML 플러그인 슬롯. 순수 함수여야 한다(모델 추론 결과를 미리 계산해 넘기는 어댑터 포함). */
export interface LayoutPlugin {
  name: string;
  proposeRegions(model: PageModel): readonly RegionProposal[];
}

/** DOM·Node 타입 없이 쓰는 시계(Worker·Node 모두 performance 가 있다). */
const now = (): number =>
  (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();

export function reconstructPage(model: PageModel, _options: ReconOptions = {}): PageLayout {
  const t0 = now();
  return {
    pageIndex: model.pageIndex,
    bounds: model.bounds,
    columns: [],
    paragraphs: [],
    tables: [],
    figures: [],
    readingOrder: [],
    unassignedLines: model.lines.map((_, i) => i),
    warnings: [],
    reconMs: now() - t0,
  };
}
