import { useEffect, useState } from 'preact/hooks';
import { cssBoxStyle, type CssBox } from '../layout.js';

/** 선택 하이라이트 상자를 TextLayer(명령형 이벤트 처리)에서 오버레이(Preact)로 전달하는 작은 저장소. */
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
      // 빈 선택이 반복해서 들어올 때 다시 그리지 않는다.
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

/** 선택 영역 하이라이트. 글자 span 수천 개를 다시 비교하지 않도록 자체 상태만 갱신한다. */
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
