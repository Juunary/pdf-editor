/**
 * M5 벤치마크 지표 이벤트(계약 D1). 이름은 `performance.mark` 이름과 같다.
 * 시작·끝 이벤트 사이 시간이 한 표본이다.
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

/** 대체안(패스 판정 지연)에서 패스 판정 완료 시점. */
export const M5_JUDGE_PATHS_READY = 'm5:judge:paths-ready';

export type M5Metric = keyof typeof M5_EVENTS;

/** 표식을 남기고 그 시각(performance.now)을 돌려준다. */
export function mark(name: string, startTime?: number): number {
  const at = startTime ?? performance.now();
  try {
    performance.mark(name, { startTime: at });
  } catch {
    // 측정 API 를 쓸 수 없으면 반환값만 쓴다.
  }
  return at;
}
