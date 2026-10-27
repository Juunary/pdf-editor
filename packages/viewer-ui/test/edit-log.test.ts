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
  it('returns the committed EditOps in active-id order', () => {
    const log = new EditLog();
    log.recordCommit(commit('a', ['a']));
    log.recordCommit(commit('b', ['a', 'b']));
    expect(log.snapshot().ops.map((o) => o.id)).toEqual(['a', 'b']);
    expect(log.snapshot().activeEditIds).toEqual(['a', 'b']);
  });

  it('undo removes only the active id and keeps the EditOp so redo can restore it', () => {
    const log = new EditLog();
    log.recordCommit(commit('a', ['a']));
    log.recordCommit(commit('b', ['a', 'b']));
    log.recordHistory(history(['a']));
    expect(log.snapshot().ops.map((o) => o.id)).toEqual(['a']);
    log.recordHistory(history(['a', 'b']));
    expect(log.snapshot().ops.map((o) => o.id)).toEqual(['a', 'b']);
  });

  it('committing anew after undo discards EditOps that are not in the active ids', () => {
    const log = new EditLog();
    log.recordCommit(commit('a', ['a']));
    log.recordCommit(commit('b', ['a', 'b']));
    log.recordHistory(history(['a']));
    log.recordCommit(commit('c', ['a', 'c']));
    log.recordHistory(history(['a', 'b', 'c'])); // the discarded b is not restored
    expect(log.snapshot().ops.map((o) => o.id)).toEqual(['a', 'c']);
    expect(log.snapshot().activeEditIds).toEqual(['a', 'c']);
  });

  it('reset clears everything', () => {
    const log = new EditLog();
    log.recordCommit(commit('a', ['a']));
    log.reset();
    expect(log.snapshot()).toEqual({ ops: [], activeEditIds: [] });
  });

  it('EditPathOp (path edit/delete) is also kept in the same order as paragraph edits (M4)', () => {
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
    // After undo, a new paragraph edit discards path edits that can no longer be restored
    log.recordHistory(history(['a', 'p1']));
    log.recordCommit(commit('b', ['a', 'p1', 'b']));
    expect(log.snapshot().ops.map((o) => o.id)).toEqual(['a', 'p1', 'b']);
  });
});
