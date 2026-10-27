/**
 * The set of calls the viewer UI requires of the viewer-owned Worker. `PdfWorkerApi` (the Comlink remote) satisfies it as is.
 * The UI package does not know the Worker or MuPDF directly, so tests pass a fake implementation.
 */
import type { PdfWorkerApi } from '@pdf-editor/shared-types';

/** Edit (M3) RPCs. If the host provides all of them, the edit feature turns on; if any is missing, only editing turns off. */
export type EditHostApi = Pick<
  PdfWorkerApi,
  | 'getPageEditability'
  | 'planParagraphEdit'
  | 'beginParagraphEdit'
  | 'updateParagraphDraft'
  | 'commitParagraphEdit'
  | 'cancelParagraphEdit'
  | 'undo'
  | 'redo'
  | 'getEditHistory'
>;

export const EDIT_HOST_METHODS = [
  'getPageEditability',
  'planParagraphEdit',
  'beginParagraphEdit',
  'updateParagraphDraft',
  'commitParagraphEdit',
  'cancelParagraphEdit',
  'undo',
  'redo',
  'getEditHistory',
] as const satisfies readonly (keyof EditHostApi)[];

/** Vector path editing (M4) RPCs. If any is missing, only path editing turns off (independent of paragraph editing). */
export type PathHostApi = Pick<
  PdfWorkerApi,
  'planPathEdit' | 'beginPathEdit' | 'updatePathDraft' | 'commitPathEdit' | 'cancelPathEdit'
>;

export const PATH_HOST_METHODS = [
  'planPathEdit',
  'beginPathEdit',
  'updatePathDraft',
  'commitPathEdit',
  'cancelPathEdit',
] as const satisfies readonly (keyof PathHostApi)[];

export type ViewerHost = Pick<
  PdfWorkerApi,
  | 'getPageInfo'
  | 'renderPage'
  | 'extractPage'
  | 'getSourceMap'
  | 'linkPage'
  | 'searchText'
  | 'getPageLayout'
> &
  Partial<EditHostApi> &
  Partial<PathHostApi> & {
    /** Diagnostic log (e.g. the extension viewer's DiagLog). Feature disablement and errors are recorded here. */
    log(event: string, data?: unknown): void;
  };

/** Environment values used for render scale calculation. */
export interface ViewerEnvironment {
  devicePixelRatio: number;
  /** CSS width available to the viewer. */
  availableWidth: number;
}

/** Whether the host provides all the edit RPCs. */
export function hasEditHost(host: ViewerHost): host is ViewerHost & EditHostApi {
  return EDIT_HOST_METHODS.every((m) => typeof host[m] === 'function');
}

/** Whether the host provides all the path edit RPCs. */
export function hasPathHost(host: ViewerHost): host is ViewerHost & PathHostApi {
  return PATH_HOST_METHODS.every((m) => typeof host[m] === 'function');
}
