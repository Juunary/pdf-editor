/**
 * Input buffer (moved from M3, M4 contract 4.5): after a double-click starts editing, collects the characters the user types until the editor opens
 * (the plan → begin round trip) so they are not lost, then inserts them at the caret position once the editor is open.
 *
 * Focus is placed on a hidden textarea, so IME composition is received as well. When handing over, `blur()` finalizes any composition in progress
 * (V7 measurement: blur during composition → compositionend, composition string finalized).
 */
import { normalizeInput } from './edit-text.js';

export interface InputBufferPort {
  /** Starts collecting (must be called within a user gesture to receive focus). */
  open(): void;
  /** Returns the collected characters (normalized: NFC, U+00A0 → U+0020, CRLF → LF) and closes. */
  take(): string;
  /** Discards the collected characters and closes. */
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
    // If the text-layer selection made by the double-click remains, the composition breaks (same reason as in the editor).
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
