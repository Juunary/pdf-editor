/**
 * e2e 공용 툴바 조작. 저장 버튼 셋(저장·다른 이름으로 저장·downloads 저장)은 프린터 아이콘 메뉴 하나로 바뀌었다
 * (사용자 요청 2026-10-22). 메뉴 항목은 이전 버튼 id(`#save`·`#save-as`·`#save-downloads`)를 그대로 쓴다.
 */
import type { Frame, Page } from '@playwright/test';

export type SaveMenuItem = 'save' | 'save-as' | 'save-downloads';

/** 저장 메뉴(`#save-menu-button`)를 열고 항목을 누른다. 이미 열려 있으면 그대로 누른다. */
export async function chooseSave(target: Page | Frame, item: SaveMenuItem): Promise<void> {
  if (!(await target.locator('#save-menu').isVisible())) await target.click('#save-menu-button');
  await target.click(`#${item}`);
}
