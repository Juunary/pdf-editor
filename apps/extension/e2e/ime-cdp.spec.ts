/**
 * V7(docs/m3-contract.md 6.1): Playwright 번들 Chromium 에서 CDP `Input.imeSetComposition`·`Input.insertText` 로
 * composition 이벤트가 재현되는지 확인한다. 편집기(viewer-ui) 없이 일반 textarea 에서 이벤트 순서만 기록한다.
 * 실제 편집기 IME 시나리오(I1–I8)는 edit-ui.spec.ts 가 같은 CDP 호출로 확인한다.
 *
 * 한계: CDP 합성 입력은 실제 IME 가 보내는 `keydown`(key=Process, keyCode 229)을 만들지 않는다. 그 경로는
 * Windows 사용자 확인(계약 7절 5번)으로 확인한다.
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';

interface Ev {
  type: string;
  data: string | null;
  inputType: string | null;
  isComposing: boolean | null;
  value: string;
}

const PAGE = `<textarea id="t" rows="3" cols="30"></textarea>
<script>
window.__ev = [];
const t = document.getElementById('t');
for (const type of ['keydown', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend']) {
  t.addEventListener(type, (e) => {
    window.__ev.push({ type, data: e.data ?? null, inputType: e.inputType ?? null, isComposing: e.isComposing ?? null, value: t.value });
  });
}
</script>`;

async function setup(page: Page): Promise<CDPSession> {
  await page.setContent(PAGE);
  await page.focus('#t');
  return page.context().newCDPSession(page);
}

/** 쌓인 이벤트를 꺼내 `type:inputType` 문자열 목록으로 돌려준다. */
async function drain(page: Page): Promise<Ev[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __ev: Ev[] };
    const e = w.__ev;
    w.__ev = [];
    return e;
  });
}

const names = (events: Ev[]) =>
  events.map((e) => (e.inputType ? `${e.type}:${e.inputType}` : e.type));

test.describe('V7: CDP IME 재현', () => {
  test('imeSetComposition: 조합 시작·갱신, 같은 문자열을 반복해도 갱신 이벤트', async ({
    page,
  }) => {
    const cdp = await setup(page);
    await cdp.send('Input.imeSetComposition', { text: 'ㅎ', selectionStart: 1, selectionEnd: 1 });
    const first = await drain(page);
    expect(names(first)).toEqual([
      'compositionstart',
      'compositionupdate',
      'beforeinput:insertCompositionText',
      'input:insertCompositionText',
    ]);
    expect(first.at(-1)).toMatchObject({ data: 'ㅎ', isComposing: true, value: 'ㅎ' });

    await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
    const second = await drain(page);
    expect(names(second)).toEqual([
      'compositionupdate',
      'beforeinput:insertCompositionText',
      'input:insertCompositionText',
    ]);
    // 조합 문자열은 textarea 값 안에서 교체된다(앞 조합 'ㅎ' 이 '한' 으로 바뀜).
    expect(second.at(-1)).toMatchObject({ data: '한', value: '한' });
  });

  test('insertText: 조합 중이면 확정(compositionend), 아니면 일반 insertText', async ({ page }) => {
    const cdp = await setup(page);
    await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
    await drain(page);
    await cdp.send('Input.insertText', { text: '한' });
    const commit = await drain(page);
    expect(names(commit)).toEqual([
      'compositionupdate',
      'beforeinput:insertCompositionText',
      'input:insertCompositionText',
      'compositionend',
    ]);
    // 확정 직전 input 도 isComposing=true, compositionend 가 뒤따른다. compositionend.data = 확정 문자열.
    expect(commit.at(-1)).toMatchObject({ type: 'compositionend', data: '한', value: '한' });

    await cdp.send('Input.insertText', { text: 'abc' });
    const plain = await drain(page);
    expect(names(plain)).toEqual(['beforeinput:insertText', 'input:insertText']);
    expect(plain[0]).toMatchObject({ data: 'abc', isComposing: false });
    expect(await page.inputValue('#t')).toBe('한abc');
  });

  test('조합 중 blur 는 compositionend 로 확정(추가 input 없음)', async ({ page }) => {
    const cdp = await setup(page);
    await cdp.send('Input.imeSetComposition', { text: '글', selectionStart: 1, selectionEnd: 1 });
    await drain(page);
    await page.evaluate(() => (document.getElementById('t') as HTMLTextAreaElement).blur());
    const events = await drain(page);
    expect(names(events)).toEqual(['compositionend']);
    expect(events[0]).toMatchObject({ data: '글', value: '글' });
  });

  test('조합 문자열을 비우면 compositionend(input.data = null)', async ({ page }) => {
    const cdp = await setup(page);
    await cdp.send('Input.imeSetComposition', { text: 'ㄱ', selectionStart: 1, selectionEnd: 1 });
    await drain(page);
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    const events = await drain(page);
    expect(names(events)).toEqual([
      'compositionupdate',
      'beforeinput:insertCompositionText',
      'input:insertCompositionText',
      'compositionend',
    ]);
    expect(events[2]).toMatchObject({ data: null, value: '' });
  });

  test('keyboard.press 는 keydown → beforeinput(deleteContentBackward)', async ({ page }) => {
    const cdp = await setup(page);
    await cdp.send('Input.insertText', { text: 'ab' });
    await drain(page);
    await page.keyboard.press('Backspace');
    const events = await drain(page);
    expect(names(events)).toEqual([
      'keydown',
      'beforeinput:deleteContentBackward',
      'input:deleteContentBackward',
    ]);
    expect(await page.inputValue('#t')).toBe('a');
  });
});
