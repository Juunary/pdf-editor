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

  it('EditPathOp(패스 편집·삭제)도 문단 편집과 같은 순서로 보관한다(M4)', () => {
    const pathOp = (id: string, del: boolean): EditOp => ({
      kind: 'edit-path',
      id,
      target: { pageIndex: 0, paintSeqs: [3], fingerprints: [], bbox: [0, 0, 1, 1] },
      edit: {
        transform: null,
        fill: [1, 0, 0],
        stroke: null,
        lineWidth: null,
        points: null,
        delete: del,
      },
    });
    const log = new EditLog();
    log.recordCommit(commit('a', ['a']));
    log.recordCommit({ op: pathOp('p1', false), history: history(['a', 'p1']) });
    log.recordCommit({ op: pathOp('p2', true), history: history(['a', 'p1', 'p2']) });
    expect(log.snapshot().ops.map((o) => o.kind)).toEqual([
      'replace-paragraph',
      'edit-path',
      'edit-path',
    ]);
    // undo 뒤 새 문단 편집을 하면 되살릴 수 없는 패스 편집은 버린다
    log.recordHistory(history(['a', 'p1']));
    log.recordCommit(commit('b', ['a', 'p1', 'b']));
    expect(log.snapshot().ops.map((o) => o.id)).toEqual(['a', 'p1', 'b']);
  });
});
