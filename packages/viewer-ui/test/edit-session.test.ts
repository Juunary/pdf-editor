import { describe, expect, it, vi } from 'vitest';
import { EditSession, type EditSessionView } from '../src/edit-session.js';
import { WORKER_RECOVERED_ERROR_NAME } from '../src/failure.js';
import { FakeEditHost, type FakeParagraph } from './fake-edit-host.js';
import type { Rect, ReplaceParagraphOp } from '@pdf-editor/shared-types';

const PARAGRAPH: FakeParagraph = { id: 3, bbox: [100, 50, 150, 90], text: 'ab cd efgh' };

function recoveredError(): Error {
  const e = new Error('Worker 를 복구했습니다');
  e.name = WORKER_RECOVERED_ERROR_NAME;
  return e;
}

async function start(
  options: { paragraph?: FakeParagraph; caret?: number | null; areaLimit?: Rect } = {},
): Promise<{
  host: FakeEditHost;
  session: EditSession;
  views: EditSessionView[];
  clock: { t: number };
}> {
  const host = new FakeEditHost({
    paragraphs: [options.paragraph ?? PARAGRAPH],
    ...(options.areaLimit ? { areaLimit: options.areaLimit } : {}),
  });
  const paragraph = options.paragraph ?? PARAGRAPH;
  const plan = await host.planParagraphEdit(0, paragraph.id);
  const begun = await host.beginParagraphEdit(0, paragraph.id, plan.revision, 2);
  const clock = { t: 100 };
  const views: EditSessionView[] = [];
  const session = new EditSession(
    {
      rpc: host,
      now: () => clock.t,
      renderScale: () => 2,
      log: vi.fn(),
      onChange: (v) => views.push(v),
    },
    plan,
    begun,
    options.caret ?? null,
  );
  return { host, session, views, clock };
}

describe('EditSession start', () => {
  it('the start frame is the begin result and the caret is at the given position (the end if none)', async () => {
    const { session } = await start({ caret: 3 });
    const v = session.view();
    expect(v.editor.text).toBe('ab cd efgh');
    expect(v.editor.caret).toBe(3);
    expect(v.shown.text).toBe('ab cd efgh');
    // R-L1: use begin.first.region as the first region (seq 0).
    expect(v.region?.seq).toBe(0);
    expect(v.dirty).toBe(false);
    expect((await start()).session.view().editor.caret).toBe(10);
  });
});

describe('start region (R-L1)', () => {
  it('uses the first region at the scale passed to begin and does not send a start-update RPC', async () => {
    const { session, host } = await start({ caret: 3 });
    session.start();
    await session.settle();
    const v = session.view();
    expect(host.inputs).toHaveLength(0);
    expect(host.calls.find((c) => c.method === 'beginParagraphEdit')?.args[3]).toBe(2);
    expect(v.region?.seq).toBe(0);
    expect(session.reportPainted(0)).toBeNull();
    expect(v.dirty).toBe(false);
  });
});

describe('input sending (last input only)', () => {
  it('input is applied to the model immediately, and the processed frame is kept together with the text at input time', async () => {
    const { session, host } = await start({ caret: 10 });
    session.typeText('X');
    expect(session.view().editor.text).toBe('ab cd efghX');
    expect(session.view().shown.text).toBe('ab cd efgh'); // still the previous frame
    expect(session.view().updating).toBe(true);
    await session.settle();
    const v = session.view();
    expect(v.shown.text).toBe('ab cd efghX');
    expect(v.shown.caret).toBe(11);
    expect(v.updating).toBe(false);
    expect(v.dirty).toBe(true);
    const sent = host.inputs.at(-1)!;
    expect(sent.runs.map((r) => r.text).join('')).toBe('ab cd efghX');
    expect(sent.renderScale).toBe(2);
    expect(sent.composition).toBeNull();
  });

  it('while processing, only the last input is sent (intermediate inputs are merged)', async () => {
    const { session, host } = await start({ caret: 10 });
    const release = host.hold('updateParagraphDraft');
    session.typeText('1'); // sent (held)
    session.typeText('2'); // waiting
    session.typeText('3'); // overwrites the waiting one
    session.typeText('4');
    expect(host.count('updateParagraphDraft')).toBe(1);
    release();
    await session.settle();
    expect(host.count('updateParagraphDraft')).toBe(2);
    expect(host.inputs.map((i) => i.runs.map((r) => r.text).join(''))).toEqual([
      'ab cd efgh1',
      'ab cd efgh1234',
    ]);
    expect(session.view().shown.text).toBe('ab cd efgh1234');
  });

  it('IME composition: sends the composition range and, on commit, composition disappears (I1)', async () => {
    const { session, host } = await start({ caret: 2 });
    session.compositionStart();
    session.compositionUpdate('ㅎ');
    await session.settle();
    expect(host.inputs.at(-1)!.composition).toEqual([2, 3]);
    expect(session.view().shown.composition).toEqual([2, 3]);
    expect(session.view().shown.caret).toBe(3);
    session.compositionUpdate('한');
    session.compositionEnd('한');
    await session.settle();
    expect(host.inputs.at(-1)!.composition).toBeNull();
    expect(session.view().shown.text).toBe('ab한 cd efgh');
  });

  it('even when a composing character moves to the next line at a line end, the frame caret and composition follow (I3)', async () => {
    const { session } = await start({ caret: 5 });
    // Width 50 = 5 characters. Putting a composition string after "ab cd" moves it to the line after 'ab cd'.
    session.compositionStart();
    session.compositionUpdate('가나');
    await session.settle();
    const v = session.view();
    expect(v.shown.composition).toEqual([5, 7]);
    const line = v.shown.reflow.lines.findIndex((l) => 5 >= l.start && 5 < l.end);
    expect(line).toBeGreaterThanOrEqual(0);
    expect(v.shown.reflow.glyphs.filter((g) => g.offset >= 5 && g.offset < 7)).toHaveLength(2);
  });

  it('an update error is kept as error and retried on the next input', async () => {
    const { session, host } = await start({ caret: 10 });
    host.failNext('updateParagraphDraft', new Error('boom'));
    session.typeText('a');
    await session.settle();
    expect(session.view().error).toBe('boom');
    session.typeText('b');
    await session.settle();
    expect(session.view().error).toBeNull();
    expect(session.view().shown.text).toBe('ab cd efghab');
  });

  it('paste, Backspace and undo are sent as input', async () => {
    const { session, host } = await start({ caret: 10 });
    session.paste('XY\r\nZ');
    await session.settle();
    expect(session.view().editor.text).toBe('ab cd efghXY\nZ');
    session.backspace();
    session.undo();
    await session.settle();
    expect(session.view().editor.text).toBe('ab cd efghXY\nZ');
    session.undo();
    await session.settle();
    expect(session.view().editor.text).toBe('ab cd efgh');
    expect(
      host.inputs
        .at(-1)!
        .runs.map((r) => r.text)
        .join(''),
    ).toBe('ab cd efgh');
    expect(session.view().canRedo).toBe(true);
  });
});

describe('caret movement and pointer', () => {
  it('up/down movement is computed on reflow lines after the preceding input has been processed', async () => {
    const { session } = await start({ caret: 3 });
    session.typeText('Z'); // input right after which the line may change
    session.moveVerticalKey(1, false);
    await session.idle();
    const s = session.view().editor;
    const lines = session.view().shown.reflow.lines;
    expect(lines.length).toBeGreaterThan(1);
    expect(s.caret).toBeGreaterThan(lines[0]!.end - 1);
  });

  it('Home/End are line-based, paragraph-based with Ctrl, and select with Shift', async () => {
    const { session } = await start({ caret: 8 });
    session.moveLineBoundary('home', false, false);
    await session.idle();
    expect(session.view().editor.caret).toBe(6); // start of the second line
    session.moveLineBoundary('end', true, false);
    await session.idle();
    expect(session.view().editor.caret).toBe(10);
    expect(session.view().editor.anchor).toBe(6);
    session.moveLineBoundary('home', false, true);
    await session.idle();
    expect(session.view().editor.caret).toBe(0);
  });

  it('left/right movement: collapses a selection if present, Shift extends, Ctrl is by word', async () => {
    const { session } = await start({ caret: 4 });
    session.moveHorizontal(1, true, false);
    session.moveHorizontal(1, true, false);
    expect([session.view().editor.anchor, session.view().editor.caret]).toEqual([4, 6]);
    session.moveHorizontal(-1, false, false);
    expect(session.view().editor.caret).toBe(4);
    session.moveHorizontal(1, false, true);
    expect(session.view().editor.caret).toBe(6);
  });

  it('pointer: click is a caret, drag is a selection, double-click is a word, triple-click is all', async () => {
    const { session } = await start({ caret: 0 });
    // First line baseline 62, character width 10, left 100: x=124 → near the boundary between offsets 2 and 3
    session.pointerDown([123, 58], 1, false);
    await session.idle();
    expect(session.view().editor.caret).toBe(2);
    session.pointerDrag([146, 58]);
    await session.idle();
    expect([session.view().editor.anchor, session.view().editor.caret]).toEqual([2, 5]);
    session.pointerUp();
    session.pointerDown([103, 58], 2, false);
    await session.idle();
    expect([session.view().editor.anchor, session.view().editor.caret]).toEqual([0, 2]); // "ab"
    session.pointerDown([103, 58], 3, false);
    await session.idle();
    expect([session.view().editor.anchor, session.view().editor.caret]).toEqual([0, 10]);
  });
});

describe('region and overflow', () => {
  it('on overflow, the region bottom edge is lowered automatically (no selection; the user region is unchanged)', async () => {
    const { session, host } = await start({
      paragraph: { id: 3, bbox: [100, 50, 150, 70], text: 'ab cd efgh ij kl mn' },
      caret: 19,
    });
    const r = session.view().shown.reflow;
    expect(r.overflow).toBe(false);
    expect(r.area[3]).toBeGreaterThan(70);
    expect(r.area[3]).toBeCloseTo(r.contentBox[3], 6);
    session.typeText(' op');
    await session.settle();
    expect(host.inputs.at(-1)!.format.area).toEqual([100, 50, 150, 70]);
    expect(host.inputs.at(-1)!.format).not.toHaveProperty('overflow');
  });

  it('even if a handle shrinks the region below the text height, it grows back to the text height', async () => {
    const { session } = await start({
      paragraph: { id: 3, bbox: [100, 50, 150, 70], text: 'ab cd efgh ij kl mn' },
    });
    const full = session.view().shown.reflow.area[3];
    session.setFormat({ area: [100, 50, 150, 58] });
    await session.settle();
    const r = session.view().shown.reflow;
    expect(r.area[3]).toBeCloseTo(full, 6);
    expect(r.overflow).toBe(false);
  });

  it('if blocked by the region limit, the overflow indicator and the overflow-clipped warning remain', async () => {
    const { session } = await start({
      paragraph: { id: 3, bbox: [100, 50, 150, 70], text: 'ab cd efgh ij kl mn' },
      areaLimit: [0, 0, 612, 80],
    });
    const r = session.view().shown.reflow;
    expect(r.overflow).toBe(true);
    expect(r.area[3]).toBe(80);
    expect(session.view().warnings.map((w) => w.kind)).toContain('overflow-clipped');
  });

  it('changing the region is reflected in format and makes it dirty', async () => {
    const { session, host } = await start();
    session.setFormat({ area: [100, 50, 200, 90] });
    await session.settle();
    expect(host.inputs.at(-1)!.format.area).toEqual([100, 50, 200, 90]);
    expect(session.view().dirty).toBe(true);
  });
});

describe('finish', () => {
  it('with no changes, commit is the same as cancel', async () => {
    const { session, host } = await start();
    const out = await session.commit();
    expect(out.kind).toBe('cancelled');
    expect(host.count('cancelParagraphEdit')).toBe(1);
    expect(host.count('commitParagraphEdit')).toBe(0);
  });

  it('with changes, commits after finishing the input in progress', async () => {
    const { session, host } = await start({ caret: 10 });
    const release = host.hold('updateParagraphDraft');
    session.typeText('q');
    session.typeText('r');
    const done = session.commit();
    release();
    const out = await done;
    expect(out.kind).toBe('committed');
    expect(
      host.inputs
        .at(-1)!
        .runs.map((r) => r.text)
        .join(''),
    ).toBe('ab cd efghqr');
    if (out.kind === 'committed') {
      expect(out.result.history.activeEditIds).toEqual([out.result.op.id]);
    }
  });

  it('committing during composition finalizes the composition and then commits (I8)', async () => {
    const { session, host } = await start({ caret: 10 });
    session.compositionStart();
    session.compositionUpdate('한');
    const out = await session.commit();
    expect(out.kind).toBe('committed');
    expect(host.inputs.at(-1)!.composition).toBeNull();
    expect(
      host.inputs
        .at(-1)!
        .runs.map((r) => r.text)
        .join(''),
    ).toBe('ab cd efgh한');
  });

  it('if the last update failed, resends the current state before commit and commits after it succeeds (review M2)', async () => {
    const { session, host } = await start({ caret: 10 });
    session.typeText('a');
    await session.settle();
    host.failNext('updateParagraphDraft', new Error('boom'));
    session.typeText('b');
    await session.settle();
    expect(session.view().error).toBe('boom');
    const out = await session.commit();
    expect(out.kind).toBe('committed');
    if (out.kind === 'committed') {
      expect((out.result.op as ReplaceParagraphOp).runs.map((r) => r.text).join('')).toBe(
        'ab cd efghab',
      );
    }
  });

  it('if the resend also fails, does not commit and shows the error with the editor kept open (review M2)', async () => {
    const { session, host } = await start({ caret: 10 });
    session.typeText('a');
    await session.settle();
    host.failNext('updateParagraphDraft', new Error('boom'));
    session.typeText('b');
    await session.settle();
    host.failNext('updateParagraphDraft', new Error('again'));
    const out = await session.commit();
    expect(out).toEqual({ kind: 'kept', error: 'again' });
    expect(host.count('commitParagraphEdit')).toBe(0);
    expect(session.view().error).toBe('again');
    expect(session.view().committing).toBe(false);
    expect(session.view().editor.text).toBe('ab cd efghab');
    // The editor is open, so input and commit can continue.
    session.typeText('c');
    const second = await session.commit();
    expect(second.kind).toBe('committed');
    if (second.kind === 'committed') {
      expect((second.result.op as ReplaceParagraphOp).runs.map((r) => r.text).join('')).toBe(
        'ab cd efghabc',
      );
    }
  });

  it('input is not accepted while the commit RPC is in progress, and committing is shown (review M2)', async () => {
    const { session, host, views } = await start({ caret: 10 });
    session.typeText('a');
    await session.settle();
    const release = host.hold('commitParagraphEdit');
    const done = session.commit();
    await vi.waitFor(() => expect(host.count('commitParagraphEdit')).toBe(1));
    expect(session.view().committing).toBe(true);
    session.typeText('z');
    session.paste('PP');
    session.backspace();
    session.compositionStart();
    session.compositionUpdate('한');
    session.compositionEnd('한');
    session.setFormat({ align: 'center' });
    expect(session.view().editor.text).toBe('ab cd efgha');
    expect(session.view().format.align).not.toBe('center');
    release();
    const out = await done;
    expect(out.kind).toBe('committed');
    if (out.kind === 'committed') {
      expect((out.result.op as ReplaceParagraphOp).runs.map((r) => r.text).join('')).toBe(
        'ab cd efgha',
      );
    }
    expect(views.some((v) => v.committing)).toBe(true);
    expect(host.count('updateParagraphDraft')).toBe(1);
  });

  it('cancel discards pending input and sends the cancel RPC', async () => {
    const { session, host } = await start({ caret: 10 });
    session.typeText('x');
    await session.cancel();
    expect(host.count('cancelParagraphEdit')).toBe(1);
    expect(host.count('commitParagraphEdit')).toBe(0);
  });
});

describe('recovery (D6)', () => {
  it('if the Worker is recovered during an update, restarts the same paragraph draft with the editor model', async () => {
    const { session, host } = await start({ caret: 10 });
    session.typeText('가');
    await session.settle();
    host.simulateRecovery();
    host.failNext('updateParagraphDraft', recoveredError());
    session.typeText('나');
    await session.settle();
    expect(host.count('planParagraphEdit')).toBe(2);
    expect(host.count('beginParagraphEdit')).toBe(2);
    const v = session.view();
    expect(v.notice).toContain('복구');
    expect(v.shown.text).toBe('ab cd efgh가나');
    expect(
      host.inputs
        .at(-1)!
        .runs.map((r) => r.text)
        .join(''),
    ).toBe('ab cd efgh가나');
  });

  it('if recovered during commit, restarts the draft and stays in edit mode', async () => {
    const { session, host } = await start({ caret: 10 });
    session.typeText('x');
    await session.settle();
    host.simulateRecovery();
    host.failNext('commitParagraphEdit', recoveredError());
    const out = await session.commit();
    expect(out.kind).toBe('restarted');
    expect(session.view().notice).toContain('복구');
    // Committing again succeeds.
    const second = await session.commit();
    expect(second.kind).toBe('committed');
  });
});

describe('response time recording', () => {
  it('reportPainted right after compositing records the input → composite time', async () => {
    const { session, clock } = await start({ caret: 10 });
    clock.t = 1000;
    session.typeText('a');
    clock.t = 1040;
    await session.settle();
    const seq = session.view().region!.seq;
    clock.t = 1060;
    expect(session.reportPainted(seq)).toBe(60);
    expect(session.reportPainted(seq + 99)).toBeNull();
    expect(session.latencies).toEqual([60]);
  });
});
