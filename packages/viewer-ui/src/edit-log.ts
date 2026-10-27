/**
 * Edit log for recovery (contract D6). The viewer keeps the `EditOp`s of commit results and uses `EditHistoryState.activeEditIds` to know which edits
 * are applied to the document now. On Worker recovery, the original + active log are reapplied with `replayEdits`.
 *
 * - undo/redo only change the active ids (EditOps are not discarded since redo can bring them back).
 * - a new commit after undo discards EditOps that are not in the active ids (the redo stack becomes invalid).
 */
import type { CommitResult, EditHistoryState, EditOp } from '@pdf-editor/shared-types';

export interface EditLogSnapshot {
  /** Order of activeEditIds (log order). */
  ops: EditOp[];
  activeEditIds: string[];
}

export class EditLog {
  private readonly ops = new Map<string, EditOp>();
  private active: string[] = [];

  /** Records a commit result. Discards EditOps not in the active ids. */
  recordCommit(result: CommitResult): void {
    this.ops.set(result.op.id, result.op);
    this.active = [...result.history.activeEditIds];
    for (const id of [...this.ops.keys()]) if (!this.active.includes(id)) this.ops.delete(id);
  }

  /** Reflects the history state after undo/redo/reapply (EditOps are kept). */
  recordHistory(history: EditHistoryState): void {
    this.active = [...history.activeEditIds];
  }

  /** Log to use for recovery. Edit ids that were not kept are skipped. */
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
