import { useEffect, useState } from 'preact/hooks';
import { cssBoxStyle, type CssBox } from '../layout.js';

/** A small store that passes the selection highlight boxes from TextLayer (imperative event handling) to the overlay (Preact). */
export interface RectsStore {
  get(): CssBox[];
  set(rects: CssBox[]): void;
  subscribe(listener: () => void): () => void;
}

export function createRectsStore(): RectsStore {
  let rects: CssBox[] = [];
  const listeners = new Set<() => void>();
  return {
    get: () => rects,
    set(next) {
      // Do not redraw when empty selections arrive repeatedly.
      if (next.length === 0 && rects.length === 0) return;
      rects = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Selection highlight. Updates only its own state so that thousands of character spans are not compared again. */
export function SelectionOverlay({ store }: { store: RectsStore }) {
  const [rects, setRects] = useState(store.get());
  useEffect(() => {
    setRects(store.get());
    return store.subscribe(() => setRects(store.get()));
  }, [store]);
  return (
    <div id="pe-selection" class="pe-sel-layer" aria-hidden="true">
      {rects.map((box, i) => (
        <div key={i} class="pe-sel" style={cssBoxStyle(box)} />
      ))}
    </div>
  );
}
