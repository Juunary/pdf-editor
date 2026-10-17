// M0 Day 1 1단계: Worker 기동 확인용 최소 엔트리. 2단계에서 뷰어로 교체한다.
const status = document.getElementById('status');
const worker = new Worker(new URL('../worker/pdf-worker.ts', import.meta.url), { type: 'module' });
worker.onmessage = (e: MessageEvent<{ ready: boolean }>) => {
  if (status) status.textContent = e.data.ready ? 'MuPDF 로드됨' : 'MuPDF 로드 실패';
};
