/**
 * Toolbar save menu (user request 2026-10-22): a single printer-icon button opens a small menu ("저장" (Save) / "다른 이름으로 저장" (Save As) / dev builds only
 * downloads save). Follows the menu button pattern (WAI-ARIA APG Menu Button).
 *
 * - Button: click, Enter, Space and ↓ open and focus the first item; ↑ opens and focuses the last item.
 * - Menu: ↑↓ (wrapping), Home and End move; Enter and Space activate (items are buttons); Esc closes and returns to the button; Tab closes.
 * - Clicking outside or the window losing focus closes it. On open and on window resize, the horizontal position is adjusted to stay on screen.
 *
 * The menu is inside the header area, so it also receives the header zoom compensation (CSS zoom). Position calculation uses the ratio of screen coordinates to the menu's own coordinates
 * (`getBoundingClientRect().width / offsetWidth`) to convert.
 */

/** Margin between the screen edge and the menu (header-area px). */
const EDGE_MARGIN = 4;

export interface SaveMenuOptions {
  button: HTMLButtonElement;
  menu: HTMLElement;
  /** Called with the item id when an item is chosen (after the menu closes). */
  onChoose(id: string): void;
}

export interface SaveMenu {
  open(focus?: 'first' | 'last'): void;
  close(returnFocus?: boolean): void;
  isOpen(): boolean;
}

/** Visible menu items (excluding items hidden in the narrow layout). */
function visibleItems(menu: HTMLElement): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter(
    (el) => !el.disabled && el.getClientRects().length > 0,
  );
}

export function setupSaveMenu({ button, menu, onChoose }: SaveMenuOptions): SaveMenu {
  const isOpen = () => !menu.hidden;

  /** Adjusts the horizontal position (left) and max height so the menu does not go off screen. */
  const place = () => {
    menu.style.left = '0px';
    menu.style.maxHeight = '';
    const r = menu.getBoundingClientRect();
    const k = menu.offsetWidth > 0 ? r.width / menu.offsetWidth : 1; // screen px per menu px
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const m = EDGE_MARGIN * k;
    let shift = 0;
    if (r.right > vw - m) shift = vw - m - r.right;
    if (r.left + shift < m) shift = m - r.left;
    menu.style.left = `${shift / k}px`;
    if (r.bottom > vh - m) menu.style.maxHeight = `${Math.max(0, (vh - m - r.top) / k)}px`;
  };

  const focusItem = (which: 'first' | 'last' | number) => {
    const items = visibleItems(menu);
    if (items.length === 0) return;
    const i =
      which === 'first'
        ? 0
        : which === 'last'
          ? items.length - 1
          : (which + items.length) % items.length;
    items[i]!.focus();
  };

  const open = (focus: 'first' | 'last' = 'first') => {
    if (button.disabled) return;
    if (!isOpen()) {
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      place();
    }
    focusItem(focus);
  };

  const close = (returnFocus = false) => {
    if (!isOpen()) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (returnFocus) button.focus();
  };

  button.addEventListener('click', () => (isOpen() ? close() : open('first')));
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      open('first');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      open('last');
    } else if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      close(true);
    }
  });

  menu.addEventListener('keydown', (e) => {
    const items = visibleItems(menu);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusItem(at + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusItem(at < 0 ? -1 : at - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusItem('first');
        break;
      case 'End':
        e.preventDefault();
        focusItem('last');
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation(); // do not hand off to document shortcuts such as closing the search box
        close(true);
        break;
      case 'Tab':
        close();
        break;
    }
  });

  menu.addEventListener('click', (e) => {
    const item = (e.target as Element | null)?.closest<HTMLButtonElement>('[role="menuitem"]');
    if (!item || item.disabled) return;
    close(true);
    onChoose(item.id);
  });

  // Outside press: close if outside the button and menu (focus is not moved).
  document.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target as Node | null;
      if (isOpen() && t && !menu.contains(t) && !button.contains(t)) close();
    },
    true,
  );
  window.addEventListener('blur', () => close());
  window.addEventListener('resize', () => {
    if (isOpen()) place();
  });

  return { open, close, isOpen };
}
