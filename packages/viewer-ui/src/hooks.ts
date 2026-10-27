import { useEffect, useState } from 'preact/hooks';
import type { ViewerController, ViewerState } from './controller.js';

/** Subscribes to the controller state. Resubscribes when the controller changes. */
export function useViewerState(controller: ViewerController): ViewerState {
  const [state, setState] = useState<ViewerState>(controller.getState());
  useEffect(() => {
    setState(controller.getState());
    return controller.subscribe(setState);
  }, [controller]);
  return state;
}
