/**
 * 툴바 저장 메뉴(사용자 요청 2026-10-22): 프린터 아이콘 버튼 하나가 작은 메뉴(저장 / 다른 이름으로 저장 / 개발 빌드만
 * downloads 저장)를 연다. 메뉴 버튼 패턴(WAI-ARIA APG Menu Button)을 따른다.
 *
 * - 버튼: 클릭·Enter·Space·↓ 는 열고 첫 항목에, ↑ 는 열고 마지막 항목에 초점.
 * - 메뉴: ↑↓(순환)·Home·End 이동, Enter·Space 실행(항목은 button), Esc 는 닫고 버튼으로, Tab 은 닫기.
 * - 바깥을 누르거나 창이 초점을 잃으면 닫는다. 열 때와 창 크기가 바뀔 때 화면 안에 들어오게 가로 위치를 맞춘다.
 *
 * 메뉴는 머리 영역 안에 있어 머리 영역 확대 보정(CSS zoom)을 같이 받는다. 위치 계산은 화면 좌표와 메뉴 자체 좌표의
 * 비(`getBoundingClientRect().width / offsetWidth`)로 바꿔 쓴다.
 */

/** 화면 가장자리와 메뉴 사이 여백(머리 영역 px). */
const EDGE_MARGIN = 4;

export interface SaveMenuOptions {
  button: HTMLButtonElement;
  menu: HTMLElement;
  /** 항목을 골랐을 때(메뉴를 닫은 뒤) 그 항목 id 로 부른다. */
  onChoose(id: string): void;
}

export interface SaveMenu {
  open(focus?: 'first' | 'last'): void;
  close(returnFocus?: boolean): void;
  isOpen(): boolean;
}

/** 보이는(좁은 배치에서 숨긴 항목 제외) 메뉴 항목. */
function visibleItems(menu: HTMLElement): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter(
    (el) => !el.disabled && el.getClientRects().length > 0,
  );
}

export function setupSaveMenu({ button, menu, onChoose }: SaveMenuOptions): SaveMenu {
  const isOpen = () => !menu.hidden;

  /** 메뉴가 화면 밖으로 나가지 않게 가로 위치(left)와 최대 높이를 맞춘다. */
  const place = () => {
    menu.style.left = '0px';
    menu.style.maxHeight = '';
    const r = menu.getBoundingClientRect();
    const k = menu.offsetWidth > 0 ? r.width / menu.offsetWidth : 1; // 화면 px / 메뉴 px
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
        e.stopPropagation(); // 검색창 닫기 등 문서 단축키로 넘기지 않는다
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

  // 바깥 누름: 버튼·메뉴 밖이면 닫는다(초점은 옮기지 않는다).
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
