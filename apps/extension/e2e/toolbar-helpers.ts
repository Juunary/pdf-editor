/**
 * Shared e2e toolbar operations. The three save buttons (save, save as, save to downloads) were replaced by a single printer-icon menu
 * (user request 2026-10-22). Menu items keep using the old button ids (`#save`·`#save-as`·`#save-downloads`).
 * Saving to downloads is a dev-only control, so the diagnostics display (`html[data-diag]`) must be turned on to see it (user request 2026-10-23).
 */
import type { Frame, Page } from '@playwright/test';

export type SaveMenuItem = 'save' | 'save-as' | 'save-downloads';

/** Turns on the diagnostics display via the viewer's shortcut handling (Ctrl+Alt+Shift+D). If it is already on, leaves it as is. */
export async function showDiag(target: Page | Frame): Promise<void> {
  await target.evaluate(() => {
    if (document.documentElement.hasAttribute('data-diag')) return;
    const init = { code: 'KeyD', key: 'D', ctrlKey: true, altKey: true, shiftKey: true };
    document.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true }));
    if (!document.documentElement.hasAttribute('data-diag'))
      throw new Error('진단 표시가 켜지지 않음');
  });
}

/** Opens the save menu (`#save-menu-button`) and clicks an item. If it is already open, just clicks. */
export async function chooseSave(target: Page | Frame, item: SaveMenuItem): Promise<void> {
  if (item === 'save-downloads') await showDiag(target);
  if (!(await target.locator('#save-menu').isVisible())) await target.click('#save-menu-button');
  await target.click(`#${item}`);
}
