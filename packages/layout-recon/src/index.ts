/**
 * 레이아웃 복원(M2, PLAN.md 4절): PageModel → PageLayout. MuPDF 에 의존하지 않는 순수 함수.
 * 계약: docs/m2-contract.md.
 */
export { fingerprintText, lineFeatures, type Box, type LineFeature } from './features.js';
export {
  summarizePaths,
  type FilledBox,
  type PathSummary,
  type Rule,
  type Shape,
} from './paths.js';
export { detectTables, type DetectedCell, type DetectedTable } from './tables.js';
export {
  reconstructPage,
  type LayoutPlugin,
  type ReconOptions,
  type RegionProposal,
} from './reconstruct.js';
export {
  kendallTau,
  scoreLayout,
  summarizeScores,
  type Counts,
  type LabelCell,
  type LabelFigure,
  type LabelItem,
  type LabelParagraph,
  type LabelTable,
  type PageLabel,
  type PageScore,
  type ScoreSummary,
} from './accuracy.js';
