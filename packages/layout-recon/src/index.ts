/**
 * Layout reconstruction (M2, PLAN.md section 4): PageModel → PageLayout. Pure functions with no MuPDF dependency.
 * Contract: docs/m2-contract.md.
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
  ROLES,
  ROLE_CONTAINER,
  ROLE_NONE,
  ROLE_PAIR_MIN_JACCARD,
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
  type RoleMatrix,
  type RoleMetrics,
  type ScoreSummary,
} from './accuracy.js';
export { validateLayout } from './validate.js';
