/**
 * Classification of feature-call failures. While M1 and M3 are implemented in parallel, some core RPCs throw a "not implemented" exception (M1: extractPage, searchText, linkPage,
 * M3: edit RPCs). In that case only the affected feature is permanently disabled; any other error fails just that call.
 * Comlink restores Worker exceptions as Error, so they are identified by message.
 *
 * `recovered`: marker that the viewer recreated the Worker and recovered the document (extension `WorkerRecoveredError`, contract D6).
 * The caller's draft/request is gone, so the caller must start over.
 */
export type FailureKind = 'unimplemented' | 'recovered' | 'error';

export interface Failure {
  kind: FailureKind;
  message: string;
}

/** `name` of the recovery notice error. A convention shared by the extension's recovery layer and the viewer UI. */
export const WORKER_RECOVERED_ERROR_NAME = 'WorkerRecoveredError';

export function classifyFailure(error: unknown): Failure {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  if (error instanceof Error && error.name === WORKER_RECOVERED_ERROR_NAME) {
    return { kind: 'recovered', message };
  }
  return { kind: message.includes('미구현') ? 'unimplemented' : 'error', message };
}
