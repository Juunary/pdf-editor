/**
 * 기능 호출 실패 분류. M1·M3 병렬 구현 중 core 의 일부 RPC 는 "미구현" 예외를 낸다(M1: extractPage·searchText·linkPage,
 * M3: 편집 RPC). 이 경우 해당 기능만 영구 비활성화하고, 그 외 오류는 그 호출만 실패로 둔다.
 * Comlink 가 Worker 예외를 Error 로 복원하므로 메시지로 판별한다.
 *
 * `recovered`: 뷰어가 Worker 를 새로 만들어 문서를 복구했다는 표시(확장 `WorkerRecoveredError`, 계약 D6).
 * 호출한 쪽의 초안·요청은 사라졌으므로 호출자가 다시 시작해야 한다.
 */
export type FailureKind = 'unimplemented' | 'recovered' | 'error';

export interface Failure {
  kind: FailureKind;
  message: string;
}

/** 복구 알림 오류의 `name`. 확장의 복구 계층과 뷰어 UI 가 공유하는 규약이다. */
export const WORKER_RECOVERED_ERROR_NAME = 'WorkerRecoveredError';

export function classifyFailure(error: unknown): Failure {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  if (error instanceof Error && error.name === WORKER_RECOVERED_ERROR_NAME) {
    return { kind: 'recovered', message };
  }
  return { kind: message.includes('미구현') ? 'unimplemented' : 'error', message };
}
