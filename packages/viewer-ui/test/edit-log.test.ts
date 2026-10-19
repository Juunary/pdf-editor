import { describe, expect, it } from 'vitest';
import type { CommitResult, EditHistoryState, EditOp } from '@pdf-editor/shared-types';
import { EditLog } from '../src/edit-log.js';

const op = (id: string): EditOp => ({
  kind: 'replace-paragraph',
  id,
  target: { pageIndex: 0, glyphSeqs: [], editedBlock: null, bbox: [0, 0, 1, 1] },
  runs: [],
  format: {
    area: [0, 0, 1, 1],
    align: 'left',
    firstLineIndent: 0,
    lineHeight: 1,
    firstBaselineOffset: 1,
    overflow: null,
  },
});
const history = (activeEditIds: string[]): EditHistoryState => ({
  revision: 1,
  activeEditIds,
  canUndo: activeEditIds.length > 0,
  canRedo: false,
  edits: activeEditIds.length,
  affectedPages: [0],
});
const commit = (id: string, active: string[]): CommitResult => ({
  op: op(id),
  history: history(active),
});

describe('EditLog', () => {
  it('커밋한 EditOp 를 활성 id 순서로 돌려준다', () => {
    const log = new EditLog();
    log.recordCommit(commit('a', ['a']));
    log.recordCommit(commit('b', ['a', 'b']));
    expect(log.snapshot().ops.map((o) => o.id)).toEqual(['a', 'b']);
    expect(log.snapshot().activeEditIds).toEqual(['a', 'b']);
  });

  it('undo 는 활성 id 만 빼고 EditOp 는 남겨 redo 로 되살린다', () => {
    const log = new EditLog();
    log.recordCommit(commit('a', ['a']));
    log.recordCommit(commit('b', ['a', 'b']));
    log.recordHistory(history(['a']));
    expect(log.snapshot().ops.map((o) => o.id)).toEqual(['a']);
    log.recordHistory(history(['a', 'b']));
    expect(log.snapshot().ops.map((o) => o.id)).toEqual(['a', 'b']);
  });

  it('undo 뒤 새로 커밋하면 활성 id 에 없는 EditOp 를 버린다', () => {
    const log = new EditLog();
    log.recordCommit(commit('a', ['a']));
    log.recordCommit(commit('b', ['a', 'b']));
    log.recordHistory(history(['a']));
    log.recordCommit(commit('c', ['a', 'c']));
    log.recordHistory(history(['a', 'b', 'c'])); // 버린 b 는 복원되지 않는다
    expect(log.snapshot().ops.map((o) => o.id)).toEqual(['a', 'c']);
    expect(log.snapshot().activeEditIds).toEqual(['a', 'c']);
  });

  it('reset 은 모두 비운다', () => {
    const log = new EditLog();
    log.recordCommit(commit('a', ['a']));
    log.reset();
    expect(log.snapshot()).toEqual({ ops: [], activeEditIds: [] });
  });
});
