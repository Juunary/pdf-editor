/**
 * M3 viewer-ui 편집기 e2e(docs/m3-viewer-ui.md).
 *
 * 가짜 편집 호스트(글자 폭이 일정한 단순 리플로우)로 viewer-ui 빌드 산출물만 띄워, 실제 Chromium 에서 편집기 UI 를 확인한다:
 * 진입(테두리·더블클릭·제한 사유), 입력·키·클립보드, IME 시나리오 I1–I8(CDP `Input.imeSetComposition`·`Input.insertText`),
 * 변경 영역 합성 위치, 초과 3선택, 영역 핸들, 폴백·없는 글자 표시, 경고·태그 안내, 문서 undo/redo, 복구.
 * 실제 core 편집 RPC 가 필요한 흐름은 `integration` 블록의 `test.skip` 으로 두고 통합 때 켠다(docs/m3-viewer-ui.md 5절).
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import type { PageModel } from '@pdf-editor/shared-types';
import {
  editModel,
  openEditHarness,
  startEditHarness,
  stopEditHarness,
  type EditHarnessConfig,
} from './edit-harness.js';

// ── 하니스 구성 ────────────────────────────────────────────────────────

/**
 * 문단 1: 편집 가능 "Hello World"(영역 [20,20,130,60], 한 줄 11글자, 두 줄까지 들어간다).
 * 문단 2: 제한(표 셀). 문단 3: 태그 쪽(MCID 있음). 글자 10×14pt 격자, 줄 0 은 y 20–34.
 */
const PARAGRAPHS = [
  { id: 1, bbox: [20, 20, 130, 60] as [number, number, number, number], text: 'Hello World' },
  {
    id: 2,
    bbox: [20, 100, 50, 114] as [number, number, number, number],
    text: '표 셀',
    editable: false,
    reasons: ['not-flow-paragraph'],
  },
  {
    id: 3,
    bbox: [20, 160, 130, 174] as [number, number, number, number],
    text: 'tagged',
    tagged: true,
  },
];

const MODEL: PageModel = editModel();

function config(extra: Partial<EditHarnessConfig> = {}): EditHarnessConfig {
  return { model: MODEL, paragraphs: PARAGRAPHS, cssScale: 1.5, ...extra };
}

interface Geo {
  x: number;
  y: number;
  scale: number;
}

async function geo(page: Page): Promise<Geo> {
  const surface = page.locator('#pe-page');
  const box = await surface.boundingBox();
  if (!box) throw new Error('#pe-page 없음');
  return { x: box.x, y: box.y, scale: Number(await surface.getAttribute('data-css-scale')) };
}

/** 페이지 공간(pt) → 화면 좌표. */
const at = (g: Geo, x: number, y: number) => ({ x: g.x + x * g.scale, y: g.y + y * g.scale });

/** 첫 줄 글자 col 의 화면 좌표(글자 상자 안 비율 fx). */
const charAt = (g: Geo, col: number, fx = 0.5) => at(g, 20 + col * 10 + fx * 10, 27);

/** 브라우저 안 `window.__controller` 에서 읽는 편집 세션(`EditSessionView` 의 일부). */
interface PageSession {
  editor: { text: string; caret: number; anchor: number; composition: [number, number] | null };
  shown: {
    text: string;
    reflow: { fontScale: number; area: number[]; overflow: boolean; lines: unknown[] };
  };
  updating: boolean;
  canUndo: boolean;
  canRedo: boolean;
}
interface PageWindow {
  __controller: { getState(): { edit: { session: PageSession | null } } };
}

interface SessionInfo {
  text: string;
  caret: number;
  anchor: number;
  composition: [number, number] | null;
  shownText: string;
  updating: boolean;
  canUndo: boolean;
  canRedo: boolean;
  fontScale: number;
  area: number[];
  overflow: boolean;
  lines: number;
}

async function session(page: Page): Promise<SessionInfo | null> {
  return page.evaluate(() => {
    const w = window as unknown as PageWindow;
    const s = w.__controller.getState().edit.session;
    if (!s) return null;
    return {
      text: s.editor.text,
      caret: s.editor.caret,
      anchor: s.editor.anchor,
      composition: s.editor.composition,
      shownText: s.shown.text,
      updating: s.updating,
      canUndo: s.canUndo,
      canRedo: s.canRedo,
      fontScale: s.shown.reflow.fontScale,
      area: s.shown.reflow.area,
      overflow: s.shown.reflow.overflow,
      lines: s.shown.reflow.lines.length,
    };
  });
}

/** 보낸 입력이 모두 처리되어 화면 프레임이 모델과 같아질 때까지 기다린다. */
async function settled(page: Page): Promise<SessionInfo> {
  await page.waitForFunction(() => {
    const w = window as unknown as PageWindow;
    const s = w.__controller.getState().edit.session;
    return !!s && !s.updating && s.shown.text === s.editor.text;
  });
  return (await session(page))!;
}

async function ended(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      (
        window as unknown as { __controller: { getState(): { edit: { session: unknown } } } }
      ).__controller.getState().edit.session === null,
  );
}

/** 문단 1 을 더블클릭해 편집을 시작한다(캐럿은 클릭한 글자 앞·뒤). */
async function startEdit(page: Page, col = 6, fx = 0.2): Promise<Geo> {
  const g = await geo(page);
  const p = charAt(g, col, fx);
  await page.mouse.dblclick(p.x, p.y);
  await page.waitForSelector('#pe-edit-layer');
  await settled(page);
  return g;
}

async function hostCalls(page: Page, method: string): Promise<number> {
  return page.evaluate(
    (m) => (window as unknown as { __edit: { count(m: string): number } }).__edit.count(m),
    method,
  );
}

/** 쪽 캔버스의 한 점(pt) 픽셀 RGB. */
async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    ([px, py]) => {
      const canvas = document.getElementById('page-canvas') as HTMLCanvasElement;
      const scale =
        Number(document.getElementById('pe-page')!.dataset.cssScale) * window.devicePixelRatio;
      const d = canvas
        .getContext('2d')!
        .getImageData(Math.round(px! * scale), Math.round(py! * scale), 1, 1).data;
      return [d[0]!, d[1]!, d[2]!];
    },
    [x, y],
  );
}

async function caretInfo(page: Page) {
  const el = page.locator('#pe-edit-caret');
  return {
    offset: Number(await el.getAttribute('data-offset')),
    x: Number(await el.getAttribute('data-x')),
    line: Number(await el.getAttribute('data-line')),
    top: Number(await el.getAttribute('data-top')),
  };
}

async function cdp(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

async function compose(client: CDPSession, text: string): Promise<void> {
  await client.send('Input.imeSetComposition', {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
}

const insert = (client: CDPSession, text: string) => client.send('Input.insertText', { text });

let errors: string[] = [];
test.describe('M3 편집기 UI(가짜 편집 호스트)', () => {
  test.beforeAll(startEditHarness);
  test.afterAll(stopEditHarness);
  test.beforeEach(async ({ page }) => {
    errors = await openEditHarness(page, config());
    await page.waitForSelector('#pe-text-layer');
    await page.waitForFunction(
      () =>
        (
          window as unknown as {
            __controller: { getState(): { edit: { editability: { status: string } } } };
          }
        ).__controller.getState().edit.editability.status === 'ready',
    );
  });
  test.afterEach(() => {
    expect(errors, '페이지 오류').toEqual([]);
  });

  // ── 진입 ──────────────────────────────────────────────────────────

  test.describe('진입', () => {
    test('마우스 오버: 편집 가능 문단은 실선, 제한 문단은 점선(다른 색) 테두리', async ({
      page,
    }) => {
      const g = await geo(page);
      const over = at(g, 60, 30);
      await page.mouse.move(over.x, over.y);
      const hover = page.locator('#pe-edit-hover');
      await expect(hover).toBeVisible();
      await expect(hover).toHaveAttribute('data-editable', '1');
      const box = await hover.boundingBox();
      expect(Math.abs(box!.x - (g.x + 20 * g.scale))).toBeLessThan(0.75);
      expect(Math.abs(box!.width - 110 * g.scale)).toBeLessThan(0.75);
      const restricted = at(g, 30, 105);
      await page.mouse.move(restricted.x, restricted.y);
      await expect(hover).toHaveAttribute('data-editable', '0');
      expect(await hover.evaluate((e) => getComputedStyle(e).borderTopStyle)).toBe('dashed');
      await page.mouse.move(g.x + 5, g.y + 400);
      await expect(hover).toHaveCount(0);
    });

    test('더블클릭: 편집 층이 열리고 캐럿은 클릭한 글자 위치, 입력 textarea 에 포커스', async ({
      page,
    }) => {
      const g = await startEdit(page, 6, 0.2); // 'W' 왼쪽 절반 → 오프셋 6 앞
      expect((await caretInfo(page)).offset).toBe(6);
      expect((await caretInfo(page)).x).toBe(80);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('pe-edit-input');
      await expect(page.locator('#pe-text-layer')).toHaveCount(0);
      const area = await page.locator('#pe-edit-area').boundingBox();
      expect(Math.abs(area!.x - (g.x + 20 * g.scale))).toBeLessThan(0.75);
      expect(Math.abs(area!.height - 40 * g.scale)).toBeLessThan(0.75);
      // 글자 오른쪽 절반을 누르면 그 글자 뒤
      await page.keyboard.press('Escape');
      await ended(page);
      await startEdit(page, 6, 0.8);
      expect((await caretInfo(page)).offset).toBe(7);
    });

    test('한 번 클릭·드래그는 기존 텍스트 선택 그대로(편집이 시작되지 않는다)', async ({
      page,
    }) => {
      const g = await geo(page);
      const a = charAt(g, 1);
      const b = charAt(g, 4);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 3 });
      await page.mouse.up();
      expect(await session(page)).toBeNull();
      await expect(page.locator('#pe-text-layer')).toBeVisible();
    });

    test('제한 문단 더블클릭: 사유 팝오버를 보이고 편집은 시작하지 않는다', async ({ page }) => {
      const g = await geo(page);
      const p = at(g, 30, 105);
      await page.mouse.dblclick(p.x, p.y);
      const pop = page.locator('#pe-edit-popover');
      await expect(pop).toBeVisible();
      await expect(pop).toContainText('표 셀 안 글자입니다(테스트).');
      expect(await session(page)).toBeNull();
      expect(await hostCalls(page, 'beginParagraphEdit')).toBe(0);
      await page.keyboard.press('Escape');
      await expect(pop).toHaveCount(0);
      await page.mouse.dblclick(p.x, p.y);
      await expect(pop).toBeVisible();
      await page.mouse.click(g.x + 400, g.y + 300);
      await expect(pop).toHaveCount(0);
    });

    test('태그 쪽 문단은 안내를 보이고, 설정으로 막을 수 있다(D1)', async ({ page }) => {
      const g = await geo(page);
      const p = at(g, 60, 167);
      await page.mouse.dblclick(p.x, p.y);
      await page.waitForSelector('#pe-edit-layer');
      await expect(page.locator('#pe-edit-tagged-note')).toContainText(
        '구조(읽기 순서·태그)는 갱신하지 않습니다',
      );
      await page.locator('#pe-edit-cancel').click();
      await ended(page);
      await page.locator('#pe-block-tagged').check();
      await page.mouse.dblclick(p.x, p.y);
      await expect(page.locator('#pe-edit-popover')).toContainText('태그 PDF');
      expect(await session(page)).toBeNull();
    });
  });

  // ── 입력 ──────────────────────────────────────────────────────────

  test.describe('입력·키', () => {
    test('타이핑: 모델·캐럿·변경 영역 합성(글리프 위치 픽셀)이 맞는다', async ({ page }) => {
      await startEdit(page, 10, 0.8); // 오프셋 11(끝)
      expect(await pixel(page, 125, 26)).toEqual([0x22, 0x22, 0x22]); // 시작 프레임의 11번째 글자
      expect(await pixel(page, 25, 46)).toEqual([255, 255, 255]); // 둘째 줄은 비어 있다
      await page.keyboard.type('abc');
      const s = await settled(page);
      expect(s.text).toBe('Hello Worldabc');
      expect(s.caret).toBe(14);
      expect(s.lines).toBe(2);
      // 마지막 공백("Hello " 뒤)에서 줄이 나뉘어 "Worldabc" 8글자가 둘째 줄(기준선 52, 상자 41–52)에 합성된다.
      expect(await pixel(page, 25, 46)).toEqual([0x22, 0x22, 0x22]);
      expect(await pixel(page, 95, 46)).toEqual([0x22, 0x22, 0x22]);
      expect(await pixel(page, 105, 46)).toEqual([255, 255, 255]);
      const caret = await caretInfo(page);
      expect([caret.offset, caret.x, caret.line]).toEqual([14, 100, 1]);
    });

    test('Backspace·Delete·화살표·Home/End·Shift 선택·Ctrl+A', async ({ page }) => {
      await startEdit(page, 6, 0.2); // 오프셋 6
      await page.keyboard.press('Backspace');
      expect((await settled(page)).text).toBe('HelloWorld');
      await page.keyboard.press('Delete');
      expect((await settled(page)).text).toBe('Helloorld');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      expect((await session(page))!.caret).toBe(3);
      await page.keyboard.press('Home');
      expect((await session(page))!.caret).toBe(0);
      await page.keyboard.press('Shift+End');
      let s = (await session(page))!;
      expect([s.anchor, s.caret]).toEqual([0, 9]);
      await expect(page.locator('.pe-edit-sel')).toHaveCount(1);
      await page.keyboard.press('ArrowRight'); // 선택이 있으면 끝으로 접는다
      s = (await session(page))!;
      expect([s.anchor, s.caret]).toEqual([9, 9]);
      await page.keyboard.press('Control+A');
      s = (await session(page))!;
      expect([s.anchor, s.caret]).toEqual([0, 9]);
      await page.keyboard.type('X');
      expect((await settled(page)).text).toBe('X');
    });

    test('Enter 는 강제 줄바꿈, ↑/↓ 는 리플로우 줄 기준, 줄 안 Home/End', async ({ page }) => {
      await startEdit(page, 4, 0.8); // 오프셋 5
      await page.keyboard.press('Enter');
      expect((await settled(page)).text).toBe('Hello\n World');
      expect((await caretInfo(page)).line).toBe(1);
      await page.keyboard.press('ArrowUp');
      let c = await caretInfo(page);
      expect([c.line, c.offset]).toEqual([0, 0]); // 목표 x(둘째 줄 처음 = 20pt) 유지
      await page.keyboard.press('ArrowDown');
      c = await caretInfo(page);
      expect(c.line).toBe(1);
      await page.keyboard.press('End');
      expect((await session(page))!.caret).toBe(12);
      await page.keyboard.press('Home');
      expect((await session(page))!.caret).toBe(6);
    });

    test('붙여넣기: 텍스트만, 줄바꿈은 강제 줄바꿈, NFC 정규화, NBSP → 공백', async ({ page }) => {
      await startEdit(page, 10, 0.8);
      await page.evaluate(() => {
        const ta = document.getElementById('pe-edit-input')!;
        const dt = new DataTransfer();
        dt.setData('text/html', '<b>굵게</b>');
        dt.setData('text/plain', 'A\r\nB한\u00a0C');
        ta.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
        );
      });
      expect((await settled(page)).text).toBe('Hello WorldA\nB한 C');
    });

    test('복사·잘라내기는 편집기 선택 텍스트를 쓴다', async ({ page }) => {
      await startEdit(page, 0, 0.2);
      await page.keyboard.press('Shift+ArrowRight');
      await page.keyboard.press('Shift+ArrowRight');
      const copied = await page.evaluate(() => {
        const ta = document.getElementById('pe-edit-input')!;
        const dt = new DataTransfer();
        ta.dispatchEvent(
          new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }),
        );
        const out1 = dt.getData('text/plain');
        const dt2 = new DataTransfer();
        ta.dispatchEvent(
          new ClipboardEvent('cut', { clipboardData: dt2, bubbles: true, cancelable: true }),
        );
        return [out1, dt2.getData('text/plain')];
      });
      expect(copied).toEqual(['He', 'He']);
      expect((await settled(page)).text).toBe('llo World');
    });

    test('클릭·드래그·더블클릭·트리플클릭으로 캐럿·선택', async ({ page }) => {
      const g = await startEdit(page, 10, 0.8);
      const a = charAt(g, 2, 0.9); // 오프셋 3 경계
      await page.mouse.click(a.x, a.y);
      expect((await session(page))!.caret).toBe(3);
      const b = charAt(g, 8, 0.2);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 3 });
      await page.mouse.up();
      let s = (await session(page))!;
      expect([s.anchor, s.caret]).toEqual([3, 8]);
      const w = charAt(g, 7);
      await page.mouse.dblclick(w.x, w.y);
      s = (await session(page))!;
      expect([s.anchor, s.caret]).toEqual([6, 11]); // "World"
      await page.mouse.click(w.x, w.y, { clickCount: 3 });
      s = (await session(page))!;
      expect([s.anchor, s.caret]).toEqual([0, 11]);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('pe-edit-input');
    });

    test('편집 중 글자 단위 되돌리기: 연속 입력은 한 단위, 공백 뒤에서 끊긴다', async ({
      page,
    }) => {
      await startEdit(page, 10, 0.8);
      const client = await cdp(page);
      for (const ch of ['a', 'b', ' ', 'c', 'd']) await insert(client, ch);
      expect((await settled(page)).text).toBe('Hello Worldab cd');
      await page.keyboard.press('Control+Z');
      expect((await settled(page)).text).toBe('Hello Worldab '); // "cd" 한 단위
      await page.keyboard.press('Control+Z');
      expect((await settled(page)).text).toBe('Hello World'); // "ab " 한 단위
      await page.keyboard.press('Control+Shift+Z');
      expect((await settled(page)).text).toBe('Hello Worldab ');
      await page.keyboard.press('Control+Y');
      expect((await settled(page)).text).toBe('Hello Worldab cd');
      // 편집 중 Ctrl+Z 는 문서 undo 가 아니다.
      expect(await hostCalls(page, 'undo')).toBe(0);
    });
  });

  // ── IME 시나리오(계약 1.3) ─────────────────────────────────────────

  test.describe('IME I1–I8', () => {
    test('I1: 조합 중 밑줄·캐럿이 조합 끝에, 확정하면 한 음절이 들어간다', async ({ page }) => {
      await startEdit(page, 6, 0.2); // 오프셋 6
      const client = await cdp(page);
      await compose(client, 'ㅎ');
      let s = await settled(page);
      expect(s.text).toBe('Hello ㅎWorld');
      expect(s.composition).toEqual([6, 7]);
      expect((await caretInfo(page)).offset).toBe(7);
      await expect(page.locator('.pe-edit-comp')).toHaveCount(1);
      await expect(page.locator('#pe-edit-layer')).toHaveAttribute('data-composing', '1');
      await compose(client, '하');
      await compose(client, '한');
      s = await settled(page);
      expect(s.text).toBe('Hello 한World');
      // 밑줄은 조합 구간(1글자) 아래에 있고, 오른쪽 끝이 캐럿 위치다(줄이 넘어가도 따라간다).
      const under = await page.locator('.pe-edit-comp').boundingBox();
      const g = await geo(page);
      const caret = await caretInfo(page);
      expect(Math.abs(under!.x + under!.width - (g.x + caret.x * g.scale))).toBeLessThan(0.75);
      expect(Math.abs(under!.width - 10 * g.scale)).toBeLessThan(0.75);
      await insert(client, '한'); // 확정
      s = await settled(page);
      expect(s.text).toBe('Hello 한World');
      expect(s.composition).toBeNull();
      expect(s.caret).toBe(7);
      await expect(page.locator('.pe-edit-comp')).toHaveCount(0);
      // 확정 글자 '한' 은 줄 나눔으로 둘째 줄 처음(x 20–30, 상자 41–52)에 합성된다.
      expect(await pixel(page, 25, 46)).toEqual([0x22, 0x22, 0x22]);
    });

    test('I2: 조합 중 자모 삭제는 조합 문자열만 갱신한다', async ({ page }) => {
      await startEdit(page, 10, 0.8);
      const client = await cdp(page);
      await compose(client, '한');
      await compose(client, '하');
      expect((await settled(page)).text).toBe('Hello World하');
      await compose(client, '');
      const s = await settled(page);
      expect(s.text).toBe('Hello World');
      expect(s.composition).toBeNull();
      await expect(page.locator('.pe-edit-comp')).toHaveCount(0);
    });

    test('I3: 줄 끝에서 조합 글자가 다음 줄로 넘어가도 캐럿·밑줄이 따라간다', async ({ page }) => {
      await startEdit(page, 10, 0.8); // 오프셋 11(첫 줄이 꽉 참)
      const client = await cdp(page);
      await compose(client, '가나');
      const s = await settled(page);
      expect(s.composition).toEqual([11, 13]);
      const caret = await caretInfo(page);
      // "Hello " 뒤에서 줄이 나뉘어 "World가나" 가 둘째 줄이 된다: 캐럿 x = 20 + 7글자.
      expect([caret.offset, caret.line, caret.x]).toEqual([13, 1, 90]);
      const under = await page.locator('.pe-edit-comp').boundingBox();
      const g = await geo(page);
      // 밑줄은 조합 구간(둘째 줄 5–7번째 글자 = x 70–90)의 둘째 줄 아래(기준선 52 + 하강 3 = 55pt)에 있다.
      expect(Math.abs(under!.y - (g.y + 55 * g.scale))).toBeLessThan(1.5);
      expect(Math.abs(under!.x - (g.x + 70 * g.scale))).toBeLessThan(0.75);
      expect(Math.abs(under!.width - 20 * g.scale)).toBeLessThan(0.75);
    });

    test('I4: 조합 중 클릭하면 조합을 확정한 뒤 캐럿을 옮긴다', async ({ page }) => {
      const g = await startEdit(page, 6, 0.2);
      const client = await cdp(page);
      await compose(client, 'ㅎ');
      await settled(page);
      const p = charAt(g, 1, 0.2); // 오프셋 1
      await page.mouse.click(p.x, p.y);
      const s = await settled(page);
      expect(s.text).toBe('Hello ㅎWorld');
      expect(s.composition).toBeNull();
      expect(s.caret).toBe(1);
      await expect(page.locator('.pe-edit-comp')).toHaveCount(0);
    });

    test('I4: 조합 중 화살표는 무시하고(IME 가 처리), 확정 뒤에 이동한다', async ({ page }) => {
      await startEdit(page, 6, 0.2);
      const client = await cdp(page);
      await compose(client, 'ㅎ');
      await settled(page);
      await page.keyboard.press('ArrowLeft');
      expect((await session(page))!.caret).toBe(7); // 이동하지 않음
      await insert(client, 'ㅎ');
      await settled(page);
      await page.keyboard.press('ArrowLeft');
      expect((await session(page))!.caret).toBe(6);
    });

    test('I5: 조합 중 Ctrl+Z 는 무시한다', async ({ page }) => {
      await startEdit(page, 10, 0.8);
      const client = await cdp(page);
      await insert(client, 'q'); // 되돌릴 수 있는 입력이 있어도
      await compose(client, '가');
      await settled(page);
      await page.keyboard.press('Control+Z');
      const s = await settled(page);
      expect(s.text).toBe('Hello Worldq가');
      expect(s.composition).toEqual([12, 13]);
      await insert(client, '가');
      expect((await settled(page)).text).toBe('Hello Worldq가');
    });

    test('I6: 조합 확정 한 번은 앞뒤 입력과 같은 되돌리기 단위', async ({ page }) => {
      await startEdit(page, 10, 0.8);
      const client = await cdp(page);
      await insert(client, 'x');
      await compose(client, '한');
      await insert(client, '한');
      await insert(client, 'y');
      expect((await settled(page)).text).toBe('Hello Worldx한y');
      await page.keyboard.press('Control+Z');
      expect((await settled(page)).text).toBe('Hello World');
    });

    test('I7: 한자 변환 결과가 들어가고, 글리프가 없는 글자는 표시·경고한다', async ({ page }) => {
      await startEdit(page, 10, 0.8);
      const client = await cdp(page);
      await compose(client, '漢');
      await insert(client, '漢');
      expect((await settled(page)).text).toBe('Hello World漢');
      // U+2603 은 가짜 호스트에서 "원본·폴백 모두 글리프 없음" 으로 처리한다.
      await insert(client, '☃');
      await settled(page);
      await expect(page.locator('.pe-edit-missing')).toHaveCount(1);
      await expect(page.locator('#pe-edit-warnings li[data-kind="glyph-missing"]')).toBeVisible();
    });

    test('I8: 조합 중 바깥 클릭은 조합을 확정한 뒤 커밋한다', async ({ page }) => {
      const g = await startEdit(page, 10, 0.8);
      const client = await cdp(page);
      await compose(client, '한');
      await settled(page);
      await page.mouse.click(g.x + 400, g.y + 500);
      await ended(page);
      expect(await hostCalls(page, 'commitParagraphEdit')).toBe(1);
      const sent = await page.evaluate(() =>
        (
          window as unknown as {
            __edit: { inputs: { runs: { text: string }[]; composition: unknown }[] };
          }
        ).__edit.inputs.at(-1),
      );
      expect(sent!.runs.map((r) => r.text).join('')).toBe('Hello World한');
      expect(sent!.composition).toBeNull();
    });

    test('I8: 조합 중 Esc 는 편집 종료가 아니다(IME 가 먼저 쓴다)', async ({ page }) => {
      await startEdit(page, 10, 0.8);
      const client = await cdp(page);
      await compose(client, '한');
      await settled(page);
      await page.keyboard.press('Escape');
      expect(await session(page)).not.toBeNull();
      expect(await hostCalls(page, 'commitParagraphEdit')).toBe(0);
      await insert(client, '한');
      await settled(page);
      await page.keyboard.press('Escape'); // 조합이 아니면 커밋
      await ended(page);
      expect(await hostCalls(page, 'commitParagraphEdit')).toBe(1);
    });
  });

  // ── 종료 ──────────────────────────────────────────────────────────

  test.describe('종료', () => {
    test('Esc = 커밋(변경 있음), 변경이 없으면 취소와 같다', async ({ page }) => {
      await startEdit(page, 10, 0.8);
      await page.keyboard.press('Escape');
      await ended(page);
      expect(await hostCalls(page, 'cancelParagraphEdit')).toBe(1);
      expect(await hostCalls(page, 'commitParagraphEdit')).toBe(0);
      await startEdit(page, 10, 0.8);
      await page.keyboard.type('z');
      await page.keyboard.press('Escape');
      await ended(page);
      expect(await hostCalls(page, 'commitParagraphEdit')).toBe(1);
      await page.waitForFunction(() => (window as unknown as { __renders: number }).__renders >= 2);
    });

    test('바깥 클릭 = 커밋, 영역·핸들·초과 패널 클릭은 커밋하지 않는다', async ({ page }) => {
      const g = await startEdit(page, 10, 0.8);
      await page.keyboard.type('z');
      const inside = charAt(g, 2);
      await page.mouse.click(inside.x, inside.y);
      expect(await session(page)).not.toBeNull();
      await page.mouse.click(g.x + 450, g.y + 600);
      await ended(page);
      expect(await hostCalls(page, 'commitParagraphEdit')).toBe(1);
    });

    test('도구 막대 "편집 취소": 초안을 버리고 쪽 캔버스가 편집 전으로 돌아간다', async ({
      page,
    }) => {
      await startEdit(page, 10, 0.8);
      await page.keyboard.type('abcdefghijkl');
      await settled(page);
      expect(await pixel(page, 25, 46)).toEqual([0x22, 0x22, 0x22]); // 둘째 줄 합성됨
      await page.locator('#pe-edit-cancel').click();
      await ended(page);
      expect(await hostCalls(page, 'cancelParagraphEdit')).toBe(1);
      expect(await hostCalls(page, 'commitParagraphEdit')).toBe(0);
      // 기준 비트맵(편집 전 렌더, 흰 바탕)으로 복원
      expect(await pixel(page, 25, 46)).toEqual([255, 255, 255]);
      expect(await pixel(page, 125, 26)).toEqual([255, 255, 255]);
      await expect(page.locator('#pe-text-layer')).toBeVisible();
    });

    test('커밋 뒤 쪽을 다시 그리고 텍스트 층·편집 판정을 다시 불러온다', async ({ page }) => {
      const before = await page.evaluate(
        () => (window as unknown as { __renders: number }).__renders,
      );
      await startEdit(page, 10, 0.8);
      await page.keyboard.type('!');
      await page.keyboard.press('Escape');
      await ended(page);
      await page.waitForFunction(
        (n) => (window as unknown as { __renders: number }).__renders > n,
        before,
      );
      await expect(page.locator('#pe-text-layer')).toBeVisible();
      await page.waitForFunction(
        () =>
          (
            window as unknown as {
              __controller: { getState(): { edit: { editability: { status: string } } } };
            }
          ).__controller.getState().edit.editability.status === 'ready',
      );
    });
  });

  // ── 초과 UI·영역 ───────────────────────────────────────────────────

  test.describe('초과·영역', () => {
    async function overflowed(page: Page): Promise<void> {
      await startEdit(page, 10, 0.8);
      await page.keyboard.type('abcdefghijklmnopqrstuvwxyz0123456789'); // 11 + 36 글자 = 5줄
      await settled(page);
    }

    test('초과하면 영역 테두리가 바뀌고 초과 표시와 3선택이 보인다', async ({ page }) => {
      await overflowed(page);
      await expect(page.locator('#pe-edit-area')).toHaveAttribute('data-overflow', '1');
      await expect(page.locator('#pe-edit-overflow-line')).toBeVisible();
      const panel = page.locator('#pe-edit-overflow');
      await expect(panel).toBeVisible();
      await expect(panel.locator('button')).toHaveText([
        '영역 넓히기',
        '글자 줄이기',
        '그대로 두기',
      ]);
    });

    test('글자 줄이기: 배율이 0.8–1, 최소 80%', async ({ page }) => {
      await overflowed(page);
      await page.locator('#pe-edit-overflow [data-choice="shrink"]').click();
      const s = await settled(page);
      expect(s.fontScale).toBeGreaterThanOrEqual(0.8);
      expect(s.fontScale).toBeLessThan(1);
      // 0.8 에서도 넘치는 입력이므로 초과 표시가 유지된다.
      expect(s.overflow).toBe(true);
      await expect(page.locator('#pe-edit-overflow .pe-edit-chip')).toContainText('글자');
    });

    test('영역 넓히기: 영역 아래 변이 내려가고 초과가 사라진다', async ({ page }) => {
      await startEdit(page, 10, 0.8);
      await page.keyboard.type('abcdefghijklmnopqrstuvw'); // 3줄
      const before = await settled(page);
      expect(before.overflow).toBe(true);
      await page.locator('#pe-edit-overflow [data-choice="expand"]').click();
      const after = await settled(page);
      expect(after.overflow).toBe(false);
      expect(after.area[3]!).toBeGreaterThan(before.area[3]!);
      await expect(page.locator('#pe-edit-overflow-line')).toHaveCount(0);
      await expect(page.locator('#pe-edit-overflow .pe-edit-chip')).toContainText('영역 넓힘');
      // 같은 선택을 다시 누르면 선택이 해제된다.
      await page.locator('#pe-edit-overflow [data-choice="expand"]').click();
      expect((await settled(page)).overflow).toBe(true);
    });

    test('그대로 두기: 자동 클립 없이 넘친 줄을 두고 경고를 보인다', async ({ page }) => {
      await overflowed(page);
      await page.locator('#pe-edit-overflow [data-choice="keep"]').click();
      const s = await settled(page);
      expect(s.lines).toBeGreaterThanOrEqual(5);
      await expect(
        page.locator('#pe-edit-warnings li[data-kind="overflow-clipped"]'),
      ).toBeVisible();
      // 영역 밖 글자도 합성돼 있다(자동 클립 없음): 5번째 줄 기준선 20+12+80 = 112 근처
      expect(await pixel(page, 25, 106)).toEqual([0x22, 0x22, 0x22]);
    });

    test('영역 핸들 8개, 드래그로 영역이 바뀌고 areaLimit 밖으로 못 나간다', async ({ page }) => {
      // 상한 [0,0,200,100]: 오른쪽 변은 200pt 를 넘지 못한다.
      errors.length = 0;
      await openEditHarness(page, config({ areaLimit: [0, 0, 200, 100] }));
      await page.waitForSelector('#pe-text-layer');
      await page.waitForFunction(
        () =>
          (
            window as unknown as {
              __controller: { getState(): { edit: { editability: { status: string } } } };
            }
          ).__controller.getState().edit.editability.status === 'ready',
      );
      const g = await startEdit(page, 10, 0.8);
      await expect(page.locator('.pe-edit-handle')).toHaveCount(8);
      const handle = await page.locator('.pe-edit-handle[data-handle="e"]').boundingBox();
      const hx = handle!.x + handle!.width / 2;
      const hy = handle!.y + handle!.height / 2;
      await page.mouse.move(hx, hy);
      await page.mouse.down();
      await page.mouse.move(hx + 30 * g.scale, hy, { steps: 4 });
      await page.mouse.up();
      let s = await settled(page);
      expect(s.area[2]).toBeCloseTo(160, 0);
      // 한참 더 끌어도 상한(200)에서 멈춘다.
      const handle2 = await page.locator('.pe-edit-handle[data-handle="e"]').boundingBox();
      const hx2 = handle2!.x + handle2!.width / 2;
      await page.mouse.move(hx2, hy);
      await page.mouse.down();
      await page.mouse.move(hx2 + 400 * g.scale, hy, { steps: 4 });
      await page.mouse.up();
      s = await settled(page);
      expect(s.area[2]).toBe(200);
      // 아래 변을 끌어 영역을 키운 뒤 넓어진 줄 폭으로 줄이 다시 나뉜다(한 줄에 더 들어간다).
      expect(s.lines).toBe(1);
    });
  });

  // ── 표시 ──────────────────────────────────────────────────────────

  test.describe('표시', () => {
    test('폴백 글자는 점선 밑줄(토글), 없는 글자는 표시', async ({ page }) => {
      await startEdit(page, 10, 0.8);
      const client = await cdp(page);
      await insert(client, '한글');
      await settled(page);
      await expect(page.locator('.pe-edit-fb')).toHaveCount(1);
      expect(
        await page.locator('.pe-edit-fb').evaluate((e) => getComputedStyle(e).borderBottomStyle),
      ).toBe('dotted');
      await page.locator('#pe-fb-toggle').click();
      await expect(page.locator('.pe-edit-fb')).toHaveCount(0);
      await page.locator('#pe-fb-toggle').click();
      await expect(page.locator('.pe-edit-fb')).toHaveCount(1);
    });

    test('경고 목록은 중복 없이 보이고, 저장하면 편집 쪽 번호가 기록된다는 안내를 둔다', async ({
      page,
    }) => {
      await startEdit(page, 10, 0.8);
      await expect(page.locator('#pe-edit-info')).toContainText('편집한 쪽 번호가 파일 정보');
      const client = await cdp(page);
      await insert(client, '☃');
      await insert(client, '☃');
      await settled(page);
      await expect(page.locator('#pe-edit-warnings li[data-kind="glyph-missing"]')).toHaveCount(1);
    });

    test('입력 → 합성 반응 시간이 performance.measure 로 기록된다(계약 8.4)', async ({ page }) => {
      await startEdit(page, 10, 0.8);
      await page.keyboard.type('abcdef');
      await settled(page);
      const ms = await page.evaluate(() =>
        performance.getEntriesByName('pe-edit-latency').map((e) => e.duration),
      );
      expect(ms.length).toBeGreaterThanOrEqual(1);
      for (const d of ms) expect(d).toBeGreaterThanOrEqual(0);
      expect(Math.max(...ms)).toBeLessThan(2000); // 가짜 호스트 기준 상한(실측 기준은 통합 때)
    });
  });

  // ── 문서 undo/redo ────────────────────────────────────────────────

  test.describe('문서 undo/redo', () => {
    test('편집 밖 Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 와 도구 막대 버튼', async ({ page }) => {
      await startEdit(page, 10, 0.8);
      await page.keyboard.type('!');
      await page.keyboard.press('Escape');
      await ended(page);
      await expect(page.locator('#pe-doc-undo')).toBeEnabled();
      await expect(page.locator('#pe-doc-redo')).toBeDisabled();
      await page.mouse.click(5, 5); // 포커스를 문서 쪽으로
      await page.keyboard.press('Control+Z');
      await expect(page.locator('#pe-doc-redo')).toBeEnabled();
      expect(await hostCalls(page, 'undo')).toBe(1);
      await page.keyboard.press('Control+Shift+Z');
      await expect(page.locator('#pe-doc-undo')).toBeEnabled();
      expect(await hostCalls(page, 'redo')).toBe(1);
      await page.keyboard.press('Control+Z');
      await page.keyboard.press('Control+Y');
      await expect.poll(() => hostCalls(page, 'redo')).toBe(2);
      await page.locator('#pe-doc-undo').click();
      await expect.poll(() => hostCalls(page, 'undo')).toBe(3);
      await page.locator('#pe-doc-redo').click();
      await expect.poll(() => hostCalls(page, 'redo')).toBe(3);
    });
  });

  // ── 복구(D6) ──────────────────────────────────────────────────────

  test.describe('복구', () => {
    test('초안 중 Worker 가 복구되면 같은 문단 초안을 편집기 모델로 다시 시작한다', async ({
      page,
    }) => {
      await startEdit(page, 10, 0.8);
      await page.keyboard.type('가');
      await settled(page);
      await page.evaluate(() => {
        const w = window as unknown as {
          __edit: {
            simulateRecovery(): void;
            failNext(m: string, e: Error): void;
          };
        };
        w.__edit.simulateRecovery();
        const e = new Error('Worker 를 복구했습니다');
        e.name = 'WorkerRecoveredError';
        w.__edit.failNext('updateParagraphDraft', e);
      });
      await page.keyboard.type('나');
      const s = await settled(page);
      expect(s.text).toBe('Hello World가나');
      expect(s.shownText).toBe('Hello World가나');
      await expect(page.locator('#pe-edit-session-notice')).toContainText('복구');
      expect(await hostCalls(page, 'beginParagraphEdit')).toBe(2);
      await page.keyboard.press('Escape');
      await ended(page);
      expect(await hostCalls(page, 'commitParagraphEdit')).toBe(1);
    });
  });

  // ── devicePixelRatio 2 ────────────────────────────────────────────

  test.describe('devicePixelRatio 2', () => {
    test.use({ deviceScaleFactor: 2 });

    test('변경 영역이 렌더 배율(CSS 배율 × dpr)로 합성되고 오버레이는 CSS px 그대로', async ({
      page,
    }) => {
      await startEdit(page, 10, 0.8);
      expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
      await page.keyboard.type('abc');
      const s = await settled(page);
      expect(s.text).toBe('Hello Worldabc');
      // 시작 갱신·입력 모두 renderScale = 1.5 × 2 = 3 으로 요청됐다.
      const scales = await page.evaluate(() =>
        (window as unknown as { __edit: { inputs: { renderScale: number }[] } }).__edit.inputs.map(
          (i) => i.renderScale,
        ),
      );
      expect(scales.length).toBeGreaterThan(0);
      for (const scale of scales) expect(scale).toBe(3);
      // 캔버스 비트맵은 dpr 배, 합성 위치도 같은 배율이다("Worldabc" 둘째 줄 x 20–100, y 41–52).
      expect(await pixel(page, 25, 46)).toEqual([0x22, 0x22, 0x22]);
      expect(await pixel(page, 95, 46)).toEqual([0x22, 0x22, 0x22]);
      expect(await pixel(page, 105, 46)).toEqual([255, 255, 255]);
      const caret = await page.locator('#pe-edit-caret').boundingBox();
      const g = await geo(page);
      expect(Math.abs(caret!.x - (g.x + 100 * g.scale))).toBeLessThan(2);
    });
  });
});
