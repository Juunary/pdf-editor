/**
 * 입력 버퍼(M3 이관, M4 계약 4.5): 더블클릭으로 편집을 시작하고 편집기가 열릴 때까지(plan → begin 왕복) 사용자가
 * 치는 글자가 사라지지 않게 모았다가, 편집기가 열린 뒤 캐럿 위치에 넣는다.
 *
 * 숨은 textarea 에 포커스를 두므로 IME 조합도 그대로 받는다. 넘길 때 `blur()` 로 진행 중인 조합을 확정한다
 * (V7 실측: 조합 중 blur → compositionend, 조합 문자열 확정).
 */
import { normalizeInput } from './edit-text.js';

export interface InputBufferPort {
  /** 모으기를 시작한다(사용자 제스처 안에서 호출해야 포커스를 받는다). */
  open(): void;
  /** 모은 글자(정규화: NFC·U+00A0 → U+0020·CRLF → LF)를 돌려주고 닫는다. */
  take(): string;
  /** 모은 글자를 버리고 닫는다. */
  close(): void;
}

export class DomInputBuffer implements InputBufferPort {
  private el: HTMLTextAreaElement | null = null;

  open(): void {
    this.close();
    const el = document.createElement('textarea');
    el.id = 'pe-input-buffer';
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('data-pe-keep', '');
    el.tabIndex = -1;
    el.style.cssText =
      'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;border:0;padding:0;resize:none;pointer-events:none';
    document.body.append(el);
    // 더블클릭으로 선택된 텍스트 층 선택이 남으면 조합이 끊긴다(편집기와 같은 이유).
    document.getSelection()?.removeAllRanges();
    el.focus({ preventScroll: true });
    this.el = el;
  }

  take(): string {
    const el = this.el;
    if (!el) return '';
    el.blur();
    const text = normalizeInput(el.value);
    this.close();
    return text;
  }

  close(): void {
    this.el?.remove();
    this.el = null;
  }
}
