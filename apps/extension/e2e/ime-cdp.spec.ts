/**
 * V7 (docs/m3-contract.md 6.1): checks that CDP `Input.imeSetComposition` and `Input.insertText` reproduce
 * composition events in the Playwright bundled Chromium. Records only the event order on a plain textarea, without the editor (viewer-ui).
 * The real editor IME scenarios (I1–I8) are checked by edit-ui.spec.ts with the same CDP calls.
 *
 * Limitation: CDP synthesized input does not produce the `keydown` (key=Process, keyCode 229) that a real IME sends. That path is
 * checked by the Windows user check (contract section 7, item 5).
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

/** Drains the accumulated events and returns them as a list of `type:inputType` strings. */
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

test.describe('V7: CDP IME reproduction', () => {
  test('imeSetComposition: composition start and update, update event even when the same string is repeated', async ({
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
    // The composition string is replaced inside the textarea value (the earlier composition 'ㅎ' becomes '한').
    expect(second.at(-1)).toMatchObject({ data: '한', value: '한' });
  });

  test('insertText: commits (compositionend) while composing, otherwise plain insertText', async ({
    page,
  }) => {
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
    // The input just before commit also has isComposing=true, and compositionend follows. compositionend.data = the committed string.
    expect(commit.at(-1)).toMatchObject({ type: 'compositionend', data: '한', value: '한' });

    await cdp.send('Input.insertText', { text: 'abc' });
    const plain = await drain(page);
    expect(names(plain)).toEqual(['beforeinput:insertText', 'input:insertText']);
    expect(plain[0]).toMatchObject({ data: 'abc', isComposing: false });
    expect(await page.inputValue('#t')).toBe('한abc');
  });

  test('blur during composition commits via compositionend (no extra input)', async ({ page }) => {
    const cdp = await setup(page);
    await cdp.send('Input.imeSetComposition', { text: '글', selectionStart: 1, selectionEnd: 1 });
    await drain(page);
    await page.evaluate(() => (document.getElementById('t') as HTMLTextAreaElement).blur());
    const events = await drain(page);
    expect(names(events)).toEqual(['compositionend']);
    expect(events[0]).toMatchObject({ data: '글', value: '글' });
  });

  test('clearing the composition string gives compositionend (input.data = null)', async ({
    page,
  }) => {
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

  test('keyboard.press gives keydown → beforeinput(deleteContentBackward)', async ({ page }) => {
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
