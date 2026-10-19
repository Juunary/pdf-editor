/**
 * 복구용 편집 로그(계약 D6). 뷰어는 커밋 결과의 `EditOp` 를 보관하고, `EditHistoryState.activeEditIds` 로 지금 문서에
 * 반영된 편집을 안다. Worker 복구 때 원본 + 활성 로그를 `replayEdits` 로 다시 적용한다.
 *
 * - undo·redo 는 활성 id 만 바꾼다(redo 로 되살릴 수 있으므로 EditOp 는 버리지 않는다).
 * - undo 뒤 새로 커밋하면 활성 id 에 없는 EditOp 를 버린다(redo 스택이 무효가 된다).
 */
import type { CommitResult, EditHistoryState, EditOp } from '@pdf-editor/shared-types';

export interface EditLogSnapshot {
  /** activeEditIds 순서(로그 순서). */
  ops: EditOp[];
  activeEditIds: string[];
}

export class EditLog {
  private readonly ops = new Map<string, EditOp>();
  private active: string[] = [];

  /** 커밋 결과를 기록한다. 활성 id 에 없는 EditOp 는 버린다. */
  recordCommit(result: CommitResult): void {
    this.ops.set(result.op.id, result.op);
    this.active = [...result.history.activeEditIds];
    for (const id of [...this.ops.keys()]) if (!this.active.includes(id)) this.ops.delete(id);
  }

  /** undo·redo·재적용 뒤 이력 상태를 반영한다(EditOp 는 유지). */
  recordHistory(history: EditHistoryState): void {
    this.active = [...history.activeEditIds];
  }

  /** 복구에 쓸 로그. 보관하지 않은 편집 id 가 있으면 그 id 는 건너뛴다. */
  snapshot(): EditLogSnapshot {
    const ops = this.active.flatMap((id) => {
      const op = this.ops.get(id);
      return op ? [op] : [];
    });
    return { ops, activeEditIds: ops.map((o) => o.id) };
  }

  reset(): void {
    this.ops.clear();
    this.active = [];
  }
}
