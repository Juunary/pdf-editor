# Upstream issue — MuPDF 1.28.1 (npm `mupdf`, WASM)

Status: POSTED 2026-10-19 as [ArtifexSoftware/mupdf.js#201](https://github.com/ArtifexSoftware/mupdf.js/issues/201) (account Juunary). Prepared from `docs/m0-dod-xobject-redact-save.md` §2.5 F3 (MuPDF defect F3).
Not posted to MuPDF Bugzilla (requires an account; core part references Bug 709169 in the issue text).
No files were attached; the reproduction script below writes the compared PDFs to `./out/`.
Everything below the line is the text as posted (title + body). The live issue is the reference for any later edits or replies.

---

## Title

1.28.x regression: saving with `garbage=compact` (or `deduplicate`) drops an image stream after `PDFObject.resolve()`

## Environment

- `mupdf` npm package 1.28.1 (WASM build), Node.js v22.18.0, Linux x64.
- Reproduces on 1.28.1. Does **not** reproduce on 1.27.0 or 1.26.4 (same script, same Node).
- Tested only through the npm/WASM package; I did not run `mutool` or the C library directly.
- The code paths described below are unchanged on current master (`source/pdf/pdf-write.c` last changed in b77def0ef5, `platform/wasm/lib/mupdf.ts` at 1d821cf41). I have not built master to re-test.

## Summary

After `PDFObject.resolve()` has been called on the indirect reference of a compressed image XObject (DCTDecode or FlateDecode), `PDFDocument.saveToBuffer("garbage=compact,compress")` or `"garbage=deduplicate,compress"` writes that image as a dictionary **without its stream** (the stale `/Length` key is kept). Reopening the output logs `format error: object is not a stream` and the image is missing. `garbage=yes`, saving without garbage, or only calling `get()` on the indirect reference are all fine. Destroying the wrapper returned by `resolve()` does not help.

## Steps to reproduce

Save the script below as `repro-mupdf-resolve-compact.mjs` next to a `node_modules/mupdf` (1.28.1) and run `node repro-mupdf-resolve-compact.mjs`. It builds a one-page PDF with a single 16×16 image, resolves the image XObject (or not), saves with the given options, reopens the result and checks `isStream()`.

```js
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
```

Output on 1.28.1:

```
mupdf 1.28.1 | node v22.18.0 | linux x64
kind  | filter       | touch   | save options                 | /Im is stream after reopen | render | MuPDF log
jpeg  | /DCTDecode   | resolve | garbage=compact,compress     | false                      | ok     | error: format error: object is not a stream / warning: encountered syntax errors; page may not be correct
jpeg  | /DCTDecode   | resolve | garbage=deduplicate,compress | false                      | ok     | error: format error: object is not a stream / warning: encountered syntax errors; page may not be correct
flate | /FlateDecode | resolve | garbage=compact,compress     | false                      | ok     | error: format error: object is not a stream / warning: encountered syntax errors; page may not be correct
jpeg  | /DCTDecode   | get     | garbage=compact,compress     | true                       | ok     | -
jpeg  | /DCTDecode   | resolve | garbage=yes,compress         | true                       | ok     | -
jpeg  | /DCTDecode   | resolve | compress                     | true                       | ok     | -

3 of 6 cases lost the image stream (expected 0).
```

The same script on 1.27.0 and 1.26.4 reports `0 of 6 cases lost the image stream`.

In the broken output the image object is written as a plain dictionary (3,253 bytes vs 3,790 bytes for the good output):

```
3 0 obj
<</Type/XObject/Subtype/Image/Filter/DCTDecode/BitsPerComponent 8/Width 16/Height 16/ColorSpace 5 0 R/Length 519>>
endobj
```

## Expected

`resolve()` is a read-only accessor; saving afterwards with any garbage level should produce the same stream object as saving without having called it.

## Actual

The stream data is dropped; the output PDF is damaged (`object is not a stream` on reopen, image not rendered).

## Additional observations (1.28.1)

| What is done to the image XObject before saving | `garbage=compact` keeps the stream? |
|---|---|
| `im.resolve()` (wrapper kept alive) | no |
| `im.resolve().destroy()` | no |
| `im.resolve().get("Width")` | no |
| `im.get("Width")` (indirect reference, resolved internally) | yes |
| `im.isStream()` / `im.readStream()` | yes |
| `doc.loadImage(im)` | yes |
| `page.get("Contents").resolve()` (stream dict with no indirect references inside) | yes |
| `page.resolve()` (non-stream dict) | yes |

So it takes a **stream** object whose dictionary **contains an indirect reference** (here `/ColorSpace 5 0 R`) and that has been **wrapped by `resolve()`**.

## Analysis (as far as I could follow it)

Two things combine.

**1. Core: `renumberobj` now copies shared dictionaries, and the copy loses the stream.**
Commit 19c3d109ac "Bug 709169: Fix renumberobj issue with shared pdf objects." (2026-03-16, first shipped in 1.28.0) changed `renumberobj()` in `source/pdf/pdf-write.c` so that a dictionary that contains indirect references and is not a singleton is duplicated:

```c
/* Obj is a borrowed reference. */
if (modify && !pdf_obj_is_singleton(ctx, obj))
	dup = obj = pdf_copy_dict(ctx, obj);
```

`renumberobjs()` then replaces the xref object with the duplicate via `pdf_update_object(ctx, doc, num, nval)`. `pdf_update_object()` writes into the entry returned by `pdf_get_incremental_xref_entry()`, which is a fresh entry in the new incremental section (`stm_ofs == 0`, `stm_buf == NULL`); it only sets `type`, `ofs` and `obj`. Unlike `pdf_xref_ensure_incremental_object()`, nothing copies `stm_ofs`/`stm_buf` from the old entry. When the object is written, `pdf_obj_num_is_stream()` (`entry->type == 'n' && (entry->stm_ofs != 0 || entry->stm_buf)`) is false, so the object goes out as a dictionary and the stream is gone. In 1.27.0 `renumberobj()` rewrote the dictionary in place and this path did not exist.

Consequence for any API user, not just JavaScript: a stream object whose dictionary has a reference count > 1 at save time (e.g. a `pdf_keep_obj()` on a `pdf_resolve_indirect()` result held across the save) loses its stream under `garbage=compact`/`deduplicate`.

**2. mupdf.js: every `PDFObject` wrapper takes two references and drops one.**
In `platform/wasm/lib/mupdf.ts` (1.28.1 and current master 1d821cf41):

```ts
_fromPDFObjectKeep(ptr: Pointer<"pdf_obj">) {
	if (ptr === 0)
		return PDFObject.Null
	return new PDFObject(this, libmupdf._wasm_pdf_keep_obj(ptr))   // keep #1
}
...
export class PDFObject extends Userdata<"pdf_obj"> {
	static override readonly _drop = libmupdf._wasm_pdf_drop_obj
	constructor(doc: PDFDocument, pointer: Pointer<"pdf_obj">) {
		super(libmupdf._wasm_pdf_keep_obj(pointer))                 // keep #2
		this._doc = doc
	}
```

`destroy()` / the `FinalizationRegistry` drop once, so one reference per wrapper leaks for the lifetime of the document. `resolve()` returns the xref-cached dictionary through `_fromPDFObjectKeep` (`wasm_pdf_resolve_indirect` is a plain `POINTER(pdf_resolve_indirect, obj)`, i.e. borrowed), so after `resolve()` that dictionary has `refs >= 2` and is no longer a singleton for `renumberobj()`. `get()` on the indirect reference resolves inside `pdf_dict_gets()` and never wraps the dictionary, which is why it is unaffected. The same double keep exists in 1.27.0; it was harmless until the `renumberobj` change. On its own it also means every `PDFObject` returned by the bindings pins its `pdf_obj` until the document is dropped; I have not checked whether that is related to #200.

**3. Confirmation by cancelling the extra references.** Using the exported `PDFObject._drop` (= `_wasm_pdf_drop_obj`) on the pointer returned by `resolve()`:

| Variant | refs on the cached dict at save time | stream kept? |
|---|---|---|
| `resolve()`, wrapper kept alive | 1 (xref) + 2 | no |
| `resolve().destroy()` | 1 + 1 (leaked) | no |
| `resolve()` + one extra `_drop`, wrapper kept alive | 1 + 1 | no |
| `resolve()` + one extra `_drop` + `destroy()` | 1 | **yes** |
| `resolve()` + two extra `_drop`, wrapper kept alive | 1 | **yes** |
| `get("Width")` only (control) | 1 | yes |

## Suggested fixes

- Core (`pdf-write.c`): when `renumberobj()` returns a duplicate for an object that is a stream, keep the stream with the new xref entry (copy `stm_ofs`/`stm_buf` as `pdf_xref_ensure_incremental_object()` does, or update via the stream path), or renumber stream dictionaries in place since the xref entry owns them. Writing a dictionary with a leftover `/Length` but no stream should probably never happen silently.
- mupdf.js (`mupdf.ts`): take exactly one reference per `PDFObject` — either drop the `_wasm_pdf_keep_obj` in the constructor and let `_fromPDFObjectNew` pass ownership, or drop the one in `_fromPDFObjectKeep`.

## Workaround

In a document that will be saved with `garbage=compact`/`deduplicate`, do not call `resolve()` on stream objects; read dictionary values through `get()` on the indirect reference and load images with `loadImage(ref)`. Alternatively save with `garbage=yes` or without garbage collection (both verified unaffected, same peak WASM heap in my measurements).

## Files

Running the script writes the PDFs it compares to `./out/` next to the script, e.g. `input-jpeg.pdf` (3,790 bytes), `output-jpeg-resolve-garbage_compact_compress.pdf` (3,253 bytes, broken) and `output-jpeg-get-garbage_compact_compress.pdf` (3,790 bytes, good). I can attach them here if that helps.
