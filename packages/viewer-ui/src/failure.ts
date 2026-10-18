/**
 * 기능 호출 실패 분류. M1 병렬 구현 중 core 의 extractPage·searchText·linkPage 는
 * "M1 미구현" 예외를 낸다. 이 경우 해당 기능만 영구 비활성화하고, 그 외 오류는 그 호출만 실패로 둔다.
 * Comlink 가 Worker 예외를 Error 로 복원하므로 메시지로 판별한다.
 */
export type FailureKind = 'unimplemented' | 'error';

export interface Failure {
  kind: FailureKind;
  message: string;
}

export function classifyFailure(error: unknown): Failure {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  return { kind: message.includes('미구현') ? 'unimplemented' : 'error', message };
}
