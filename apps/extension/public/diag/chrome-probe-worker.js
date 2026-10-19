/* global self, postMessage */
// M3 진단(계약 5.7): 확장 뷰어가 만든 전용 Worker 에서 chrome.* 가 되는지, 확장 자산을 fetch 할 수 있는지 확인한다.
// e2e(apps/extension/e2e/worker-chrome.spec.ts)가 이 Worker 를 만들고 결과를 읽어 docs/m3-viewer-ui.md 에 기록한다.
self.onmessage = async (e) => {
  const c = self.chrome;
  const report = {
    typeofChrome: typeof c,
    typeofRuntime: typeof (c && c.runtime),
    typeofRuntimeId: typeof (c && c.runtime && c.runtime.id),
    typeofStorage: typeof (c && c.storage),
    typeofDownloads: typeof (c && c.downloads),
    typeofDeclarativeNetRequest: typeof (c && c.declarativeNetRequest),
    isModuleWorker: false,
    fontFetch: null,
    manifestFetch: null,
  };
  try {
    const url = e.data && e.data.fontUrl;
    if (url) {
      const res = await fetch(url);
      const buf = new Uint8Array(await res.arrayBuffer());
      report.fontFetch = {
        status: res.status,
        bytes: buf.byteLength,
        magic: Array.from(buf.slice(0, 4)),
      };
    }
  } catch (err) {
    report.fontFetch = { error: String(err) };
  }
  try {
    const res = await fetch(new URL('../manifest.json', self.location.href));
    report.manifestFetch = { status: res.status };
  } catch (err) {
    report.manifestFetch = { error: String(err) };
  }
  postMessage(report);
};
