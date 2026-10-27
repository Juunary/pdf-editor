/* global self, postMessage */
// M3 diagnostics (contract 5.7): checks whether chrome.* works in the dedicated Worker created by the extension viewer, and whether extension assets can be fetched.
// The e2e test (apps/extension/e2e/worker-chrome.spec.ts) creates this Worker, reads the result and records it in docs/m3-viewer-ui.md.
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
