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

describe('EditSession 시작', () => {
  it('시작 프레임은 begin 결과이고 캐럿은 지정한 위치(없으면 끝)', async () => {
    const { session } = await start({ caret: 3 });
    const v = session.view();
    expect(v.editor.text).toBe('ab cd efgh');
    expect(v.editor.caret).toBe(3);
    expect(v.shown.text).toBe('ab cd efgh');
    // R-L1: begin.first.region 을 첫 영역으로 쓴다(seq 0).
    expect(v.region?.seq).toBe(0);
    expect(v.dirty).toBe(false);
    expect((await start()).session.view().editor.caret).toBe(10);
  });
});

describe('시작 영역(R-L1)', () => {
  it('begin 에 넘긴 배율의 첫 영역을 쓰고 시작 갱신 RPC 를 보내지 않는다', async () => {
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

describe('입력 전송(마지막 입력만)', () => {
  it('입력은 모델에 즉시 반영되고, 처리된 프레임은 입력 시점 텍스트와 함께 보관된다', async () => {
    const { session, host } = await start({ caret: 10 });
    session.typeText('X');
    expect(session.view().editor.text).toBe('ab cd efghX');
    expect(session.view().shown.text).toBe('ab cd efgh'); // 아직 이전 프레임
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

  it('처리 중이면 마지막 입력 하나만 보낸다(중간 입력은 합친다)', async () => {
    const { session, host } = await start({ caret: 10 });
    const release = host.hold('updateParagraphDraft');
    session.typeText('1'); // 전송(보류됨)
    session.typeText('2'); // 대기
    session.typeText('3'); // 대기를 덮어씀
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

  it('IME 조합: 조합 구간을 보내고 확정하면 composition 이 사라진다(I1)', async () => {
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

  it('줄 끝에서 조합 글자가 다음 줄로 넘어가도 프레임의 캐럿·조합이 따라간다(I3)', async () => {
    const { session } = await start({ caret: 5 });
    // 폭 50 = 5글자. "ab cd" 뒤에 조합 문자열을 넣으면 'ab cd' 다음 줄로 넘어간다.
    session.compositionStart();
    session.compositionUpdate('가나');
    await session.settle();
    const v = session.view();
    expect(v.shown.composition).toEqual([5, 7]);
    const line = v.shown.reflow.lines.findIndex((l) => 5 >= l.start && 5 < l.end);
    expect(line).toBeGreaterThanOrEqual(0);
    expect(v.shown.reflow.glyphs.filter((g) => g.offset >= 5 && g.offset < 7)).toHaveLength(2);
  });

  it('갱신 오류는 error 로 남기고 다음 입력에서 다시 시도한다', async () => {
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

  it('붙여넣기·Backspace·되돌리기가 입력으로 전송된다', async () => {
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

describe('캐럿 이동·포인터', () => {
  it('위·아래 이동은 앞선 입력이 처리된 뒤 리플로우 줄 기준으로 계산한다', async () => {
    const { session } = await start({ caret: 3 });
    session.typeText('Z'); // 줄이 바뀔 수 있는 입력 직후
    session.moveVerticalKey(1, false);
    await session.idle();
    const s = session.view().editor;
    const lines = session.view().shown.reflow.lines;
    expect(lines.length).toBeGreaterThan(1);
    expect(s.caret).toBeGreaterThan(lines[0]!.end - 1);
  });

  it('Home/End 는 줄 기준, Ctrl 이면 문단 기준, Shift 이면 선택', async () => {
    const { session } = await start({ caret: 8 });
    session.moveLineBoundary('home', false, false);
    await session.idle();
    expect(session.view().editor.caret).toBe(6); // 둘째 줄 처음
    session.moveLineBoundary('end', true, false);
    await session.idle();
    expect(session.view().editor.caret).toBe(10);
    expect(session.view().editor.anchor).toBe(6);
    session.moveLineBoundary('home', false, true);
    await session.idle();
    expect(session.view().editor.caret).toBe(0);
  });

  it('좌우 이동: 선택이 있으면 접는다, Shift 는 확장, Ctrl 은 단어', async () => {
    const { session } = await start({ caret: 4 });
    session.moveHorizontal(1, true, false);
    session.moveHorizontal(1, true, false);
    expect([session.view().editor.anchor, session.view().editor.caret]).toEqual([4, 6]);
    session.moveHorizontal(-1, false, false);
    expect(session.view().editor.caret).toBe(4);
    session.moveHorizontal(1, false, true);
    expect(session.view().editor.caret).toBe(6);
  });

  it('포인터: 클릭은 캐럿, 드래그는 선택, 더블클릭은 단어, 트리플클릭은 전체', async () => {
    const { session } = await start({ caret: 0 });
    // 첫 줄 기준선 62, 글자 폭 10, 왼쪽 100: x=124 → 오프셋 2 와 3 의 경계 근처
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

describe('영역·초과', () => {
  it('넘치면 영역 아래 변이 자동으로 내려간다(선택 없음, 사용자 영역은 그대로)', async () => {
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

  it('핸들로 영역을 글 높이보다 줄여도 글 높이까지 다시 늘어난다', async () => {
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

  it('영역 상한에 막히면 초과 표시와 overflow-clipped 경고가 남는다', async () => {
    const { session } = await start({
      paragraph: { id: 3, bbox: [100, 50, 150, 70], text: 'ab cd efgh ij kl mn' },
      areaLimit: [0, 0, 612, 80],
    });
    const r = session.view().shown.reflow;
    expect(r.overflow).toBe(true);
    expect(r.area[3]).toBe(80);
    expect(session.view().warnings.map((w) => w.kind)).toContain('overflow-clipped');
  });

  it('영역을 바꾸면 format 에 반영되어 dirty 가 된다', async () => {
    const { session, host } = await start();
    session.setFormat({ area: [100, 50, 200, 90] });
    await session.settle();
    expect(host.inputs.at(-1)!.format.area).toEqual([100, 50, 200, 90]);
    expect(session.view().dirty).toBe(true);
  });
});

describe('종료', () => {
  it('변경이 없으면 커밋은 취소와 같다', async () => {
    const { session, host } = await start();
    const out = await session.commit();
    expect(out.kind).toBe('cancelled');
    expect(host.count('cancelParagraphEdit')).toBe(1);
    expect(host.count('commitParagraphEdit')).toBe(0);
  });

  it('변경이 있으면 처리 중인 입력까지 마친 뒤 커밋한다', async () => {
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

  it('조합 중 커밋하면 조합을 확정한 뒤 커밋한다(I8)', async () => {
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

  it('마지막 갱신이 실패했으면 커밋 전에 현재 상태를 다시 보내고, 성공한 뒤 커밋한다(리뷰 M2)', async () => {
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

  it('다시 보내기도 실패하면 커밋하지 않고 편집기를 열어 둔 채 오류를 표시한다(리뷰 M2)', async () => {
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
    // 편집기는 열려 있어 입력·커밋을 계속할 수 있다.
    session.typeText('c');
    const second = await session.commit();
    expect(second.kind).toBe('committed');
    if (second.kind === 'committed') {
      expect((second.result.op as ReplaceParagraphOp).runs.map((r) => r.text).join('')).toBe(
        'ab cd efghabc',
      );
    }
  });

  it('커밋 RPC 처리 중 입력은 받지 않고 committing 으로 표시한다(리뷰 M2)', async () => {
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

  it('취소는 대기 입력을 버리고 취소 RPC 를 보낸다', async () => {
    const { session, host } = await start({ caret: 10 });
    session.typeText('x');
    await session.cancel();
    expect(host.count('cancelParagraphEdit')).toBe(1);
    expect(host.count('commitParagraphEdit')).toBe(0);
  });
});

describe('복구(D6)', () => {
  it('갱신 중 Worker 가 복구되면 같은 문단 초안을 편집기 모델로 다시 시작한다', async () => {
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

  it('커밋 중 복구되면 초안을 다시 시작하고 편집 모드를 유지한다', async () => {
    const { session, host } = await start({ caret: 10 });
    session.typeText('x');
    await session.settle();
    host.simulateRecovery();
    host.failNext('commitParagraphEdit', recoveredError());
    const out = await session.commit();
    expect(out.kind).toBe('restarted');
    expect(session.view().notice).toContain('복구');
    // 다시 커밋하면 성공한다.
    const second = await session.commit();
    expect(second.kind).toBe('committed');
  });
});

describe('반응 시간 기록', () => {
  it('합성 직후 reportPainted 가 입력 → 합성 시간을 기록한다', async () => {
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
