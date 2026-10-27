import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import {
  BASE_HEAP_BYTES,
  decideSaveMethod,
  estimateSaveHeap,
  FULL_SAVE_OPTIONS,
  HEAP_GROWTH_CAP_BYTES,
  HEAP_GROWTH_FACTOR,
  HEAP_WARN_FRACTION,
  journalAdvice,
  MEASURED_PEAK_HEAP_RATIO,
  SAVE_HEAP_COEFFICIENTS,
  SAVE_HEAP_MODEL_ID,
  saveHeapIncrement,
  STREAM_INPUT_PEAK_HEAP_RATIO,
  SUPPORTED_INPUT_BYTES,
  supportedInputBytes,
  WASM_HEAP_LIMIT_BYTES,
  usedHeapAfterSave,
  type SaveModelInput,
} from '../src/save-method.js';

describe('decideSaveMethod', () => {
  it('with redaction, full save regardless of the engine decision', () => {
    const d = decideSaveMethod(['redaction', 'font-embed'], true);
    expect(d.method).toBe('full');
    expect(d.options).toBe(FULL_SAVE_OPTIONS);
  });

  it('full save if canBeSavedIncrementally=false', () => {
    expect(decideSaveMethod(['annotation'], false).method).toBe('full');
  });

  it('incremental save if only annotations/metadata changed', () => {
    const d = decideSaveMethod(['annotation', 'metadata'], true);
    expect(d.method).toBe('incremental');
    expect(d.options).toBe('incremental');
  });

  it('content stream/font changes use full save', () => {
    expect(decideSaveMethod(['content-stream'], true).method).toBe('full');
    expect(decideSaveMethod(['font-embed'], true).method).toBe('full');
  });
});

describe('decideSaveMethod: expected peak heap (file size x measured ratio)', () => {
  const MIB = 2 ** 20;

  it('no heap if size is not passed (compatible with existing calls)', () => {
    expect(decideSaveMethod(['redaction'], false).heap).toBeUndefined();
  });

  it('full save ratio 4.48, incremental 3.98 (docs/m0-day1-log.md 6.5)', () => {
    expect(MEASURED_PEAK_HEAP_RATIO).toEqual({ full: 4.48, incremental: 3.98 });
    const d = decideSaveMethod(['redaction'], false, { inputBytes: 100 * MIB });
    expect(d.heap).toMatchObject({ ratio: 4.48, estimatedPeakBytes: Math.ceil(100 * MIB * 4.48) });
    expect(d.heap!.level).toBe('ok');
    expect(d.heap!.message).toBeNull();
    const i = decideSaveMethod(['annotation'], true, { inputBytes: 100 * MIB });
    expect(i.method).toBe('incremental');
    expect(i.heap!.ratio).toBe(3.98);
  });

  it('above 75% of the 2 GiB limit -> warn, above 100% -> over-limit. The save method is not changed', () => {
    expect(WASM_HEAP_LIMIT_BYTES).toBe(2147483648);
    // 2048 MiB × 0.75 / 4.48 = 342.9 MiB, 2048 / 4.48 = 457.1 MiB
    expect(estimateSaveHeap('full', { inputBytes: 342 * MIB }).level).toBe('ok');
    expect(estimateSaveHeap('full', { inputBytes: 343 * MIB }).level).toBe('warn');
    expect(estimateSaveHeap('full', { inputBytes: 457 * MIB }).level).toBe('warn');
    const over = decideSaveMethod(['content-stream'], true, { inputBytes: 458 * MIB });
    expect(over.method).toBe('full');
    expect(over.heap!.level).toBe('over-limit');
    expect(over.heap!.message).toMatch(/상한 2048 MiB 를 넘습니다/);
    expect(estimateSaveHeap('full', { inputBytes: 400 * MIB }).message).toMatch(/88%/);
  });

  it('passing the Stream input ratio (3.48) raises the over-limit boundary to 588 MiB', () => {
    const ratio = STREAM_INPUT_PEAK_HEAP_RATIO;
    expect(estimateSaveHeap('full', { inputBytes: 588 * MIB, ratio }).level).toBe('warn');
    expect(estimateSaveHeap('full', { inputBytes: 589 * MIB, ratio }).level).toBe('over-limit');
  });

  it('the limit, warning ratio and ratios can be changed', () => {
    const e = estimateSaveHeap('full', {
      inputBytes: 100 * MIB,
      limitBytes: 512 * MIB,
      warnFraction: 0.5,
      ratio: { full: 3 },
    });
    expect(e).toMatchObject({ ratio: 3, fraction: 300 / 512, level: 'warn' });
  });
});

describe('FULL_SAVE_OPTIONS (A3-6, A3-7): the stream remains after resolve() on an image XObject', () => {
  it('a garbage=yes full save does not hit the MuPDF 1.28.x compact defect (mupdf.js#201) path', () => {
    const src = new mupdf.PDFDocument();
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 16, 16], false);
    pix.clear(128);
    const ref = src.addImage(new mupdf.Image(pix.asJPEG(80, false)));
    src.insertPage(
      -1,
      src.addPage([0, 0, 50, 50], 0, { XObject: { Im: ref } }, 'q 40 0 0 40 5 5 cm /Im Do Q'),
    );
    const doc = mupdf.Document.openDocument(
      src.saveToBuffer('compress').asUint8Array().slice(),
      'application/pdf',
    ) as mupdf.PDFDocument;
    doc.findPage(0).get('Resources').get('XObject').get('Im').resolve().destroy();
    const re = mupdf.Document.openDocument(
      doc.saveToBuffer(FULL_SAVE_OPTIONS).asUint8Array().slice(),
      'application/pdf',
    ) as mupdf.PDFDocument;
    expect(re.findPage(0).get('Resources').get('XObject').get('Im').isStream()).toBe(true);
  });
});

describe('FULL_SAVE_OPTIONS (A3-7): object streams (objstms)', () => {
  const open = (bytes: Uint8Array) =>
    mupdf.Document.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument;
  const save = (bytes: Uint8Array, options: string) => {
    const doc = open(bytes);
    const out = doc.saveToBuffer(options).asUint8Array().slice();
    doc.destroy();
    return out;
  };
  const pageTexts = (bytes: Uint8Array) => {
    const doc = open(bytes);
    const texts = Array.from({ length: doc.countPages() }, (_, i) =>
      doc.loadPage(i).toStructuredText('preserve-whitespace').asText(),
    );
    doc.destroy();
    return texts;
  };
  const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');

  /** Source with the object-stream structure: a 20-page document with 40 small dictionary objects per page, saved with objstms. */
  function objstmSource(): Uint8Array {
    const doc = new mupdf.PDFDocument();
    const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
    for (let i = 0; i < 20; i++) {
      const page = doc.addPage(
        [0, 0, 200, 200],
        0,
        { Font: { F1: font } },
        `BT /F1 12 Tf 20 100 Td (Page ${i + 1}) Tj ET`,
      );
      const data = doc.newArray();
      for (let k = 0; k < 40; k++) data.push(doc.addObject({ Page: i, Index: k }));
      page.put('A37Data', data);
      doc.insertPage(-1, page);
    }
    const out = doc.saveToBuffer('garbage=yes,compress,objstms').asUint8Array().slice();
    doc.destroy();
    return out;
  }

  it('does not unpack the object-stream source (a save without objstms is at least 1.5x the input)', () => {
    const src = objstmSource();
    const out = save(src, FULL_SAVE_OPTIONS);
    expect(out.length).toBeLessThan(src.length * 1.1);
    expect(save(src, 'garbage=yes,compress').length).toBeGreaterThan(src.length * 1.5);
    expect(latin1(out)).toMatch(/\/Type\s*\/XRef/);
    expect(pageTexts(out)).toEqual(pageTexts(src));
  });

  it('a PDF-1.4 xref table source raises the header to 1.5, and objects with a nonzero generation number keep their number and generation', () => {
    const content = 'BT /F1 24 Tf 20 40 Td (Generation test) Tj ET';
    const objs: [number, number, string][] = [
      [1, 0, '<</Type/Catalog/Pages 2 0 R>>'],
      [2, 0, '<</Type/Pages/Kids[3 0 R]/Count 1>>'],
      [
        3,
        0,
        '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 5 1 R/Resources<</Font<</F1 6 2 R>>>>>>',
      ],
      [5, 1, `<</Length ${content.length}>>\nstream\n${content}\nendstream`],
      [6, 2, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'],
    ];
    let s = '%PDF-1.4\n';
    const xref = ['0000000000 65535 f ', '', '', '', '0000000000 00001 f ', '', ''];
    for (const [num, gen, body] of objs) {
      xref[num] = `${String(s.length).padStart(10, '0')} ${String(gen).padStart(5, '0')} n `;
      s += `${num} ${gen} obj\n${body}\nendobj\n`;
    }
    const at = s.length;
    s += `xref\n0 7\n${xref.join('\n')}\ntrailer\n<</Size 7/Root 1 0 R>>\nstartxref\n${at}\n%%EOF\n`;
    const out = latin1(save(new TextEncoder().encode(s), FULL_SAVE_OPTIONS));
    expect(out.slice(0, 8)).toBe('%PDF-1.5');
    expect(out).toMatch(/(^|\n)5 1 obj/);
    expect(out).toMatch(/(^|\n)6 2 obj/);
    expect(pageTexts(new Uint8Array(Buffer.from(out, 'latin1')))[0]).toContain('Generation test');
  });

  it('an encrypted document (owner password only) keeps encryption and does not put /Encrypt into an object stream', () => {
    for (const method of ['aes-256', 'rc4-128']) {
      const enc = save(
        objstmSource(),
        `garbage=yes,compress,objstms,encrypt=${method},owner-password=owner`,
      );
      const out = save(enc, FULL_SAVE_OPTIONS);
      const doc = open(out);
      expect(doc.needsPassword()).toBe(false);
      const e = doc.getTrailer().get('Encrypt');
      expect(e.isNull()).toBe(false);
      expect(
        !e.isIndirect() || new RegExp(`(^|\\n)${e.asIndirect()} 0 obj`).test(latin1(out)),
      ).toBe(true);
      doc.destroy();
      expect(pageTexts(out)).toEqual(pageTexts(enc));
    }
  });

  it('reopens even after a full save followed by an incremental save that only adds annotations on the same document (PdfSession keeps using the same document after saving)', () => {
    const src = objstmSource();
    const doc = open(src);
    doc.saveToBuffer(FULL_SAVE_OPTIONS).destroy();
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const annot = page.createAnnotation('Text');
    annot.setRect([10, 10, 30, 30]);
    annot.setContents('A3-7');
    annot.update();
    const d = decideSaveMethod(['annotation'], doc.canBeSavedIncrementally());
    expect(d.method).toBe('incremental');
    const out = doc.saveToBuffer(d.options).asUint8Array().slice();
    doc.destroy();
    expect(Buffer.from(out.subarray(0, src.length)).equals(Buffer.from(src))).toBe(true);
    const re = open(out);
    expect(re.countPages()).toBe(20);
    const notes = re
      .loadPage(0)
      .getAnnotations()
      .filter((a) => a.getContents() === 'A3-7');
    expect(notes).toHaveLength(1);
    re.destroy();
  });
});

describe('coefficient model (M5 D5, docs/m5-heap.md)', () => {
  const MIB = 2 ** 20;
  const model = (over: Partial<SaveModelInput> = {}): SaveModelInput => ({
    objectCount: 10_000,
    rawStreamBytes: 10 * MIB,
    objectStreamBytes: 2 * MIB,
    currentHeapBytes: 40 * MIB,
    baseHeapBytes: 22 * MIB,
    journalBytes: 0,
    ...over,
  });

  it('required = max(current, base + journal) + increment, expected peak = max(current, min(required x 1.2, required + 96 MiB))', () => {
    const m = model();
    const inc = saveHeapIncrement('full', 12 * MIB, m);
    const c = SAVE_HEAP_COEFFICIENTS.full;
    expect(inc).toBeCloseTo(
      c.intercept + c.objectCount * 10_000 + c.rawStreamBytes * 10 * MIB + c.objectBytes * 4 * MIB,
    );
    const e = estimateSaveHeap('full', { inputBytes: 12 * MIB, model: m });
    expect(e.model).toBe(SAVE_HEAP_MODEL_ID);
    expect(e.estimatedPeakBytes).toBe(Math.ceil((40 * MIB + inc) * HEAP_GROWTH_FACTOR));
    expect(e).toMatchObject({ objectCount: 10_000, rawStreamBytes: 10 * MIB, journalBytes: 0 });
    // For a large required amount, + 96 MiB is smaller.
    const big = estimateSaveHeap('full', {
      inputBytes: 600 * MIB,
      model: model({ rawStreamBytes: 600 * MIB, objectStreamBytes: 0 }),
    });
    const bigNeed =
      40 * MIB +
      saveHeapIncrement(
        'full',
        600 * MIB,
        model({ rawStreamBytes: 600 * MIB, objectStreamBytes: 0 }),
      );
    expect(big.estimatedPeakBytes).toBe(Math.ceil(bigNeed + HEAP_GROWTH_CAP_BYTES));
    // If the journal is larger than the current heap, base + journal is used.
    const j = estimateSaveHeap('full', {
      inputBytes: 12 * MIB,
      model: model({ journalBytes: 100 * MIB }),
    });
    expect(j.estimatedPeakBytes).toBe(Math.ceil((122 * MIB + inc) * HEAP_GROWTH_FACTOR));
  });

  it('decideSaveMethod fills heap with the coefficient model if a model is given', () => {
    const d = decideSaveMethod(['annotation'], true, { inputBytes: MIB, model: model() });
    expect(d.method).toBe('incremental');
    expect(d.heap!.model).toBe(SAVE_HEAP_MODEL_ID);
    expect(decideSaveMethod(['annotation'], true, { inputBytes: MIB }).heap!.model).toBe(
      'ratio-v0',
    );
  });

  it('supported size limit: the input size at which the expected full-save peak of an image-heavy document starts to exceed the limit', () => {
    const limit = supportedInputBytes('full');
    expect(SUPPORTED_INPUT_BYTES).toBe(limit);
    expect(limit / MIB).toBeGreaterThan(700);
    expect(limit / MIB).toBeLessThan(850);
    const at = (x: number) =>
      estimateSaveHeap('full', {
        inputBytes: x,
        model: model({
          objectCount: 0,
          rawStreamBytes: x,
          objectStreamBytes: 0,
          currentHeapBytes: BASE_HEAP_BYTES,
          baseHeapBytes: BASE_HEAP_BYTES,
        }),
      }).level;
    expect(at(limit)).not.toBe('over-limit');
    expect(at(limit + 2 * MIB)).toBe('over-limit');
  });

  it('journal limit (D4): if journal + increment > the warn boundary, a reopen recommendation is attached to the message', () => {
    const threshold = HEAP_WARN_FRACTION * WASM_HEAP_LIMIT_BYTES;
    const small = journalAdvice('full', {
      inputBytes: MIB,
      model: model({ journalBytes: 10 * MIB }),
    });
    expect(small).toMatchObject({
      advised: false,
      journalBytes: 10 * MIB,
      thresholdBytes: threshold,
    });
    const size = { inputBytes: MIB, model: model({ journalBytes: 1500 * MIB }) };
    expect(journalAdvice('full', size).advised).toBe(true);
    const e = estimateSaveHeap('full', size);
    expect(e.level).not.toBe('ok');
    // The reopen recommendation is attached by the viewer according to its state (M2: putting it in the heap text attached the same recommendation twice).
    expect(e.message).not.toMatch(/다시 열/);
    expect(e.grownHeapBasis).toBe(false);
    expect(journalAdvice('full', { inputBytes: MIB }).advised).toBe(false);
  });

  it('if there was a previous save, heap in use = the usage estimate of that save + heap grown since the save (H1)', () => {
    const prior = { usedHeapBytes: 22 * MIB, heapAfterBytes: 898 * MIB };
    expect(usedHeapAfterSave(prior, 898 * MIB)).toBe(22 * MIB);
    expect(usedHeapAfterSave(prior, 950 * MIB)).toBe(74 * MIB);
    // Second save of a 525 MiB image document (reproduction): treating the current heap of 898 MiB as in use gives over-limit; with the usage estimate it equals the first save.
    const input = 525 * MIB;
    const m = model({
      objectCount: 2104,
      rawStreamBytes: input,
      objectStreamBytes: 0,
      currentHeapBytes: 898 * MIB,
      baseHeapBytes: 22 * MIB,
    });
    const old = estimateSaveHeap('full', { inputBytes: input, model: m });
    expect(old.level).toBe('over-limit');
    expect(old.grownHeapBasis).toBe(true);
    const next = estimateSaveHeap('full', {
      inputBytes: input,
      model: { ...m, usedHeapBytes: 22 * MIB, priorSavePeakBytes: 898 * MIB },
    });
    const first = estimateSaveHeap('full', {
      inputBytes: input,
      model: { ...m, currentHeapBytes: 22 * MIB },
    });
    expect(next.estimatedPeakBytes).toBe(first.estimatedPeakBytes);
    expect(next.level).toBe('ok');
    expect(next).toMatchObject({ usedHeapBytes: 22 * MIB, priorSavePeakBytes: 898 * MIB });
    // The estimate is not smaller than the current heap (linear memory does not shrink).
    const tiny = estimateSaveHeap('full', {
      inputBytes: MIB,
      model: model({ currentHeapBytes: 898 * MIB, usedHeapBytes: 22 * MIB }),
    });
    expect(tiny.estimatedPeakBytes).toBe(898 * MIB);
  });
});
