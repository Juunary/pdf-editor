// Minimal reproduction for mupdf (npm, WASM) 1.28.1:
// After PDFObject.resolve() is called on an indirect reference to a compressed
// image XObject, PDFDocument.saveToBuffer('garbage=compact') (or 'garbage=deduplicate')
// writes that image as a dictionary without its stream. Reopening the output then
// fails with "object is not a stream" and the image is missing.
//
// Run:  node repro-mupdf-resolve-compact.mjs
// (set MUPDF_PATH=/path/to/node_modules/mupdf/dist/mupdf.js to use a specific install)
import fs from 'node:fs';
import path from 'node:path';

const spec = process.env.MUPDF_PATH ?? 'mupdf';
const mupdf = await import(spec);

function mupdfVersion() {
  try {
    const entry = import.meta.resolve(spec);
    return JSON.parse(fs.readFileSync(new URL('../package.json', entry), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

// 1-page PDF with a single 16x16 image XObject (/Im) drawn on the page.
function makeInput(kind) {
  const doc = new mupdf.PDFDocument();
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 16, 16], false);
  pix.clear(128);
  const image = kind === 'jpeg' ? new mupdf.Image(pix.asJPEG(80, false)) : new mupdf.Image(pix);
  const ref = doc.addImage(image);
  doc.insertPage(
    -1,
    doc.addPage([0, 0, 50, 50], 0, { XObject: { Im: ref } }, 'q 40 0 0 40 5 5 cm /Im Do Q'),
  );
  const bytes = doc.saveToBuffer('compress').asUint8Array().slice();
  doc.destroy();
  return bytes;
}

// touch: 'resolve' -> im.resolve() (handle destroyed right away), 'get' -> only im.get('Width')
function run(kind, touch, saveOptions) {
  const log = [];
  const setLog = typeof mupdf.setLog === 'function' ? mupdf.setLog.bind(mupdf) : () => {}; // setLog() exists since 1.28
  setLog({ error: (m) => log.push('error: ' + m), warning: (m) => log.push('warning: ' + m) });
  const input = makeInput(kind);
  const doc = mupdf.Document.openDocument(input, 'application/pdf');
  const im = doc.findPage(0).get('Resources').get('XObject').get('Im');
  const filter = String(im.get('Filter'));
  if (touch === 'resolve') im.resolve().destroy();
  else im.get('Width');
  const out = doc.saveToBuffer(saveOptions).asUint8Array().slice();
  doc.destroy();

  const re = mupdf.Document.openDocument(out, 'application/pdf');
  const im2 = re.findPage(0).get('Resources').get('XObject').get('Im');
  const isStream = im2.isStream();
  let renderError = null;
  try {
    re.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  } catch (e) {
    renderError = String(e);
  }
  re.destroy();
  setLog(null);
  return { kind, filter, touch, saveOptions, isStream, renderError, log, input, out };
}

const cases = [
  ['jpeg', 'resolve', 'garbage=compact,compress'],
  ['jpeg', 'resolve', 'garbage=deduplicate,compress'],
  ['flate', 'resolve', 'garbage=compact,compress'],
  ['jpeg', 'get', 'garbage=compact,compress'],
  ['jpeg', 'resolve', 'garbage=yes,compress'],
  ['jpeg', 'resolve', 'compress'],
];

console.log(
  `mupdf ${mupdfVersion()} | node ${process.version} | ${process.platform} ${process.arch}`,
);
console.log(
  'kind  | filter    | touch   | save options                 | /Im is stream after reopen | render | MuPDF log',
);
const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'out');
fs.mkdirSync(outDir, { recursive: true });
let failures = 0;
for (const [kind, touch, opts] of cases) {
  const r = run(kind, touch, opts);
  const ok = r.isStream && !r.renderError;
  if (!ok) failures++;
  console.log(
    `${kind.padEnd(5)} | ${r.filter.padEnd(9)} | ${touch.padEnd(7)} | ${opts.padEnd(28)} | ${String(r.isStream).padEnd(26)} | ${r.renderError ? 'ERROR' : 'ok'}     | ${r.log.join(' / ') || '-'}`,
  );
  const tag = `${kind}-${touch}-${opts.replace(/[^a-z]+/g, '_')}`;
  fs.writeFileSync(path.join(outDir, `input-${kind}.pdf`), r.input);
  fs.writeFileSync(path.join(outDir, `output-${tag}.pdf`), r.out);
}
console.log(`\n${failures} of ${cases.length} cases lost the image stream (expected 0).`);
process.exit(failures ? 1 : 0);
