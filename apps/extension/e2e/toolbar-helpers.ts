/**
 * e2e 공용 툴바 조작. 저장 버튼 셋(저장·다른 이름으로 저장·downloads 저장)은 프린터 아이콘 메뉴 하나로 바뀌었다
 * (사용자 요청 2026-10-22). 메뉴 항목은 이전 버튼 id(`#save`·`#save-as`·`#save-downloads`)를 그대로 쓴다.
 * downloads 저장은 개발 표시라 진단 표시(`html[data-diag]`)를 켜야 보인다(사용자 요청 2026-10-23).
 */
import type { Frame, Page } from '@playwright/test';

export type SaveMenuItem = 'save' | 'save-as' | 'save-downloads';

/** 진단 표시를 켠다: 뷰어의 단축키 처리(Ctrl+Alt+Shift+D)로 켠다. 이미 켜져 있으면 그대로 둔다. */
export async function showDiag(target: Page | Frame): Promise<void> {
  await target.evaluate(() => {
    if (document.documentElement.hasAttribute('data-diag')) return;
    const init = { code: 'KeyD', key: 'D', ctrlKey: true, altKey: true, shiftKey: true };
    document.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true }));
    if (!document.documentElement.hasAttribute('data-diag'))
      throw new Error('진단 표시가 켜지지 않음');
  });
}

/** 저장 메뉴(`#save-menu-button`)를 열고 항목을 누른다. 이미 열려 있으면 그대로 누른다. */
export async function chooseSave(target: Page | Frame, item: SaveMenuItem): Promise<void> {
  if (item === 'save-downloads') await showDiag(target);
  if (!(await target.locator('#save-menu').isVisible())) await target.click('#save-menu-button');
  await target.click(`#${item}`);
}
