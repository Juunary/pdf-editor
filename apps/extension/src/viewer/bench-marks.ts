/**
 * M5 benchmark metric events (contract D1). Names are the same as the `performance.mark` names.
 * The time between a start and an end event is one sample.
 */
export const M5_EVENTS = {
  open: { start: 'm5:open:bytes-received', end: 'm5:open:first-page-shown' },
  nav: { start: 'm5:nav:request', end: 'm5:nav:page-shown' },
  edit: { start: 'm5:edit:input', end: 'm5:edit:preview-composited' },
  path: { start: 'm5:path:pointermove', end: 'm5:path:frame-painted' },
  judge: { start: 'm5:judge:page-enter', end: 'm5:judge:editability-ready' },
  save: { start: 'm5:save:start', end: 'm5:save:bytes-ready' },
  mem: { start: 'm5:mem:baseline', end: 'm5:mem:end' },
} as const;

/** Time at which the path classification completes in the alternative (deferred path classification). */
export const M5_JUDGE_PATHS_READY = 'm5:judge:paths-ready';

export type M5Metric = keyof typeof M5_EVENTS;

/** Leaves a mark and returns its time (performance.now). */
export function mark(name: string, startTime?: number): number {
  const at = startTime ?? performance.now();
  try {
    performance.mark(name, { startTime: at });
  } catch {
    // If the measurement API is unavailable, use only the return value.
  }
  return at;
}
