import { useEffect, useState } from 'preact/hooks';
import type { ViewerController, ViewerState } from './controller.js';

/** 컨트롤러 상태를 구독한다. 컨트롤러가 바뀌면 다시 구독한다. */
export function useViewerState(controller: ViewerController): ViewerState {
  const [state, setState] = useState<ViewerState>(controller.getState());
  useEffect(() => {
    setState(controller.getState());
    return controller.subscribe(setState);
  }, [controller]);
  return state;
}
