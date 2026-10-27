// Synthetic PDF generator for the save-heap model (docs/m5-heap.md section 2). Writes directly to the file without WASM, so generation itself uses no heap.
// The same arguments produce the same bytes (fixed seed).
import { closeSync, openSync, writeSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

/** Synthetic document kinds. Name → generator arguments. Used as the id in the manifest and result tables. */
export const SYNTHETIC = {
  'synth-image-100': { kind: 'image', pages: 100 },
  'synth-image-300': { kind: 'image', pages: 300 },
  'synth-image-500': { kind: 'image', pages: 500 },
  'synth-image-700': { kind: 'image', pages: 700 },
  'synth-image-900': { kind: 'image', pages: 900 },
  // For checking the limit boundary (2 GiB). Real failures (over-limit) also enter the classification denominator.
  'synth-image-800': { kind: 'image', pages: 800 },
  'synth-image-1000': { kind: 'image', pages: 1000 },
  'synth-image-1100': { kind: 'image', pages: 1100 },
  'synth-image-1200': { kind: 'image', pages: 1200 },
  'synth-object-500': { kind: 'object', pages: 500 },
  'synth-object-1000': { kind: 'object', pages: 1000 },
  'synth-object-2000': { kind: 'object', pages: 2000 },
  // Synthetic stand-in for large documents in contract section 8 (validation only, excluded from the fit). Built with a configuration different from the fit set to check extrapolation.
  'large-image-mixed': { kind: 'image-mixed', pages: 160 },
  'large-object-4000': { kind: 'object-annot', pages: 4000 },
  // Object-stream heavy (M1 validation only): writes the same object layout as large-object-4000 using object streams (200 each) and an xref stream.
  // Most objects are compressed and there is one object stream per 200 objects, which sample statistics easily miss.
  'large-objstm-4000': { kind: 'objstm', pages: 4000 },
};

/** Large documents excluded from the fit and used only for validation (contract 4.2). */
export const HOLDOUT = new Set(['large-image-mixed', 'large-object-4000', 'large-objstm-4000']);

/** Number of objects in one object stream. */
export const OBJSTM_PER_STREAM = 200;

/** Image-heavy seed (same value and same bytes as `tools/spike-m0/src/save-bench.ts` writeLargePdf). */
export const IMAGE_SEED = 0x12345678;
/** Structure elements per page for object-heavy documents. 2,000 pages give about 504,000 objects. */
export const STRUCT_PER_PAGE = 248;

function writer(path) {
  const fd = openSync(path, 'w');
  let offset = 0;
  const offsets = [];
  const write = (chunk) => {
    const b = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
    writeSync(fd, b);
    offset += b.byteLength;
  };
  const obj = (num, body) => {
    offsets[num] = offset;
    write(`${num} 0 obj\n`);
    if (typeof body === 'string') write(body);
    else body.forEach(write);
    write('\nendobj\n');
  };
  const finish = (total, trailerExtra = '') => {
    const xref = offset;
    write(`xref\n0 ${total}\n0000000000 65535 f \n`);
    const lines = [];
    for (let n = 1; n < total; n++)
      lines.push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
    write(lines.join(''));
    write(`trailer\n<</Size ${total}/Root 1 0 R${trailerExtra}>>\nstartxref\n${xref}\n%%EOF\n`);
    closeSync(fd);
    return offset;
  };
  return { write, obj, finish };
}

/**
 * Image-heavy: per page, an incompressible noise image (512×512 RGB, FlateDecode about 787 KB) + 1 text line.
 * Same generation method as the large document in `docs/m0-dod-xobject-redact-save.md` 3.2.
 */
export function writeImagePdf(path, pages) {
  const { write, obj, finish } = writer(path);
  const pageNum = (i) => 4 + i * 3;
  write('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  obj(1, '<</Type/Catalog/Pages 2 0 R>>');
  obj(
    2,
    `<</Type/Pages/Count ${pages}/Kids[${Array.from({ length: pages }, (_, i) => `${pageNum(i)} 0 R`).join(' ')}]>>`,
  );
  obj(3, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>');
  let state = IMAGE_SEED;
  const noise = new Uint8Array(512 * 512 * 3);
  for (let i = 0; i < pages; i++) {
    const p = pageNum(i);
    const content = `BT /F1 11 Tf 60 700 Td (Large document page ${i + 1}: replacement target line.) Tj ET\nq 200 0 0 200 56 300 cm /Im Do Q\n`;
    obj(
      p,
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 3 0 R>>/XObject<</Im ${p + 2} 0 R>>>>/Contents ${p + 1} 0 R>>`,
    );
    obj(p + 1, `<</Length ${content.length}>>\nstream\n${content}\nendstream`);
    for (let k = 0; k < noise.length; k++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      noise[k] = state & 0xff;
    }
    const flate = deflateSync(noise, { level: 1 });
    obj(p + 2, [
      Buffer.from(
        `<</Type/XObject/Subtype/Image/Width 512/Height 512/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/FlateDecode/Length ${flate.byteLength}>>\nstream\n`,
        'latin1',
      ),
      flate,
      Buffer.from('\nendstream', 'latin1'),
    ]);
  }
  return finish(4 + pages * 3);
}

/**
 * Object-heavy (tagged-document shape): per page, `STRUCT_PER_PAGE` text lines (each with an MCID) + one /P structure element object per line.
 * Objects = catalog, page tree, font, structure root, parent tree + per page (page + content + 248 structure elements + 1 page structure element).
 */
export function writeObjectPdf(path, pages, annots = false) {
  const { write, obj, finish } = writer(path);
  const per = STRUCT_PER_PAGE;
  // page, content, page structure element (/Sect), line structure elements + (annots) 2 link annotations·2 actions
  const extra = annots ? 4 : 0;
  const perPage = 3 + per + extra;
  const first = 7;
  const pageNum = (i) => first + i * perPage;
  write('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  obj(1, '<</Type/Catalog/Pages 2 0 R/StructTreeRoot 4 0 R/MarkInfo<</Marked true>>>>');
  obj(
    2,
    `<</Type/Pages/Count ${pages}/Kids[${Array.from({ length: pages }, (_, i) => `${pageNum(i)} 0 R`).join(' ')}]>>`,
  );
  obj(3, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>');
  obj(4, `<</Type/StructTreeRoot/ParentTree 5 0 R/K 6 0 R>>`);
  // Parent tree: page i → array of line structure elements. All put in a single number tree (MuPDF does not read it on open).
  const nums = [];
  for (let i = 0; i < pages; i++) {
    const p = pageNum(i);
    const kids = Array.from({ length: per }, (_, k) => `${p + 3 + k} 0 R`).join(' ');
    nums.push(`${i}[${kids}]`);
  }
  obj(5, `<</Nums[${nums.join(' ')}]>>`);
  obj(
    6,
    `<</Type/StructElem/S/Document/P 4 0 R/K[${Array.from({ length: pages }, (_, i) => `${pageNum(i) + 2} 0 R`).join(' ')}]>>`,
  );
  for (let i = 0; i < pages; i++) {
    const p = pageNum(i);
    const a = p + 3 + per;
    const annotRefs = annots ? `/Annots[${a} 0 R ${a + 1} 0 R]` : '';
    obj(
      p,
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/StructParents ${i}/Resources<</Font<</F1 3 0 R>>>>/Contents ${p + 1} 0 R${annotRefs}>>`,
    );
    if (annots) {
      for (let k = 0; k < 2; k++) {
        obj(
          a + k,
          `<</Type/Annot/Subtype/Link/Rect[40 ${20 + k * 14} 200 ${32 + k * 14}]/Border[0 0 0]/A ${a + 2 + k} 0 R>>`,
        );
        obj(a + 2 + k, `<</S/URI/URI(https://example.org/doc/${i + 1}/${k + 1})>>`);
      }
    }
    const lines = [];
    for (let k = 0; k < per; k++) {
      const y = 800 - (k % 62) * 12.5;
      const x = 40 + Math.floor(k / 62) * 130;
      lines.push(
        `/P<</MCID ${k}>>BDC BT /F1 6 Tf ${x} ${y.toFixed(1)} Td (p${i + 1} l${k + 1} text) Tj ET EMC`,
      );
    }
    const content = lines.join('\n');
    obj(p + 1, `<</Length ${content.length}>>\nstream\n${content}\nendstream`);
    obj(
      p + 2,
      `<</Type/StructElem/S/Sect/P 6 0 R/Pg ${p} 0 R/K[${Array.from({ length: per }, (_, k) => `${p + 3 + k} 0 R`).join(' ')}]>>`,
    );
    for (let k = 0; k < per; k++)
      obj(p + 3 + k, `<</Type/StructElem/S/P/P ${p + 2} 0 R/Pg ${p} 0 R/K ${k}>>`);
  }
  return finish(first + pages * perPage);
}

/**
 * Mixed images: per page, 1 noise image (512×512, incompressible) + 1 well-compressible gradient image (1024×1024 RGB, small raw
 * stream, 3 MiB decoded) + 40 text lines. A document whose raw stream /Length and decoded size differ greatly.
 */
export function writeImageMixedPdf(path, pages) {
  const { write, obj, finish } = writer(path);
  const per = 5; // page, content, noise image, gradient image, (spare) per-page unique font dictionary
  const pageNum = (i) => 4 + i * per;
  write('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  obj(1, '<</Type/Catalog/Pages 2 0 R>>');
  obj(
    2,
    `<</Type/Pages/Count ${pages}/Kids[${Array.from({ length: pages }, (_, i) => `${pageNum(i)} 0 R`).join(' ')}]>>`,
  );
  obj(3, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>');
  let state = IMAGE_SEED ^ 0x5a5a5a5a;
  const noise = new Uint8Array(512 * 512 * 3);
  const grad = new Uint8Array(1024 * 1024 * 3);
  const image = (num, w, data, level) => {
    const flate = deflateSync(data, { level });
    obj(num, [
      Buffer.from(
        `<</Type/XObject/Subtype/Image/Width ${w}/Height ${w}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/FlateDecode/Length ${flate.byteLength}>>\nstream\n`,
        'latin1',
      ),
      flate,
      Buffer.from('\nendstream', 'latin1'),
    ]);
  };
  for (let i = 0; i < pages; i++) {
    const p = pageNum(i);
    const lines = [];
    for (let k = 0; k < 40; k++)
      lines.push(
        `BT /F1 9 Tf 60 ${(780 - k * 11).toFixed(0)} Td (Mixed page ${i + 1} line ${k + 1} body text for size.) Tj ET`,
      );
    const content = `${lines.join('\n')}\nq 200 0 0 200 56 40 cm /Im Do Q\nq 240 0 0 240 300 40 cm /Gr Do Q\n`;
    obj(
      p,
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 3 0 R>>/XObject<</Im ${p + 2} 0 R/Gr ${p + 3} 0 R>>>>/Contents ${p + 1} 0 R/PieceInfo ${p + 4} 0 R>>`,
    );
    obj(p + 1, `<</Length ${content.length}>>\nstream\n${content}\nendstream`);
    for (let k = 0; k < noise.length; k++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      noise[k] = state & 0xff;
    }
    image(p + 2, 512, noise, 1);
    for (let y = 0; y < 1024; y++) {
      for (let x = 0; x < 1024; x++) {
        const o = (y * 1024 + x) * 3;
        grad[o] = (x + i) & 0xff;
        grad[o + 1] = (y >> 2) & 0xff;
        grad[o + 2] = ((x ^ y) >> 4) & 0xff;
      }
    }
    image(p + 3, 1024, grad, 6);
    obj(p + 4, `<</Bench<</LastModified(D:20261021000000Z)/Private(page ${i + 1})>>>>`);
  }
  return finish(4 + pages * per);
}

/**
 * Object-stream heavy: uses the same objects as `writeObjectPdf` (1 content per page + 249 structure elements + page dictionary), but puts all non-stream objects
 * into object streams (`OBJSTM_PER_STREAM` each, FlateDecode) and ends with an xref stream. Object-stream numbers follow the regular objects,
 * and the xref stream has the last number.
 */
export function writeObjStmPdf(path, pages) {
  const fd = openSync(path, 'w');
  let offset = 0;
  const write = (chunk) => {
    const b = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
    writeSync(fd, b);
    offset += b.byteLength;
  };
  const per = STRUCT_PER_PAGE;
  const perPage = 3 + per;
  const first = 7;
  const pageNum = (i) => first + i * perPage;
  const regular = first + pages * perPage; // regular object numbers 1..regular-1
  const packedCount = first - 1 + pages * (perPage - 1); // everything except content streams
  const objstmCount = Math.ceil(packedCount / OBJSTM_PER_STREAM);
  const xrefNum = regular + objstmCount;
  const size = xrefNum + 1;
  const type = new Uint8Array(size);
  const f2 = new Uint32Array(size); // type 1: offset, type 2: object stream number
  const f3 = new Uint16Array(size); // type 2: index within the object stream
  let nextStm = regular;
  let pending = [];
  const flush = () => {
    if (pending.length === 0) return;
    const num = nextStm++;
    const heads = [];
    const bodies = [];
    let at = 0;
    pending.forEach(([n, body], i) => {
      heads.push(`${n} ${at}`);
      bodies.push(body);
      at += Buffer.byteLength(body, 'latin1') + 1;
      type[n] = 2;
      f2[n] = num;
      f3[n] = i;
    });
    const header = `${heads.join(' ')}\n`;
    const data = deflateSync(Buffer.from(`${header}${bodies.join('\n')}\n`, 'latin1'), {
      level: 6,
    });
    type[num] = 1;
    f2[num] = offset;
    write(
      `${num} 0 obj\n<</Type/ObjStm/N ${pending.length}/First ${header.length}/Filter/FlateDecode/Length ${data.byteLength}>>\nstream\n`,
    );
    write(data);
    write('\nendstream\nendobj\n');
    pending = [];
  };
  const packed = (n, body) => {
    pending.push([n, body]);
    if (pending.length === OBJSTM_PER_STREAM) flush();
  };
  write('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  packed(1, '<</Type/Catalog/Pages 2 0 R/StructTreeRoot 4 0 R/MarkInfo<</Marked true>>>>');
  packed(
    2,
    `<</Type/Pages/Count ${pages}/Kids[${Array.from({ length: pages }, (_, i) => `${pageNum(i)} 0 R`).join(' ')}]>>`,
  );
  packed(3, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>');
  packed(4, '<</Type/StructTreeRoot/ParentTree 5 0 R/K 6 0 R>>');
  const nums = [];
  for (let i = 0; i < pages; i++) {
    const p = pageNum(i);
    nums.push(`${i}[${Array.from({ length: per }, (_, k) => `${p + 3 + k} 0 R`).join(' ')}]`);
  }
  packed(5, `<</Nums[${nums.join(' ')}]>>`);
  packed(
    6,
    `<</Type/StructElem/S/Document/P 4 0 R/K[${Array.from({ length: pages }, (_, i) => `${pageNum(i) + 2} 0 R`).join(' ')}]>>`,
  );
  for (let i = 0; i < pages; i++) {
    const p = pageNum(i);
    packed(
      p,
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/StructParents ${i}/Resources<</Font<</F1 3 0 R>>>>/Contents ${p + 1} 0 R>>`,
    );
    const lines = [];
    for (let k = 0; k < per; k++) {
      const y = 800 - (k % 62) * 12.5;
      const x = 40 + Math.floor(k / 62) * 130;
      lines.push(
        `/P<</MCID ${k}>>BDC BT /F1 6 Tf ${x} ${y.toFixed(1)} Td (p${i + 1} l${k + 1} text) Tj ET EMC`,
      );
    }
    const content = lines.join('\n');
    type[p + 1] = 1;
    f2[p + 1] = offset;
    write(`${p + 1} 0 obj\n<</Length ${content.length}>>\nstream\n${content}\nendstream\nendobj\n`);
    packed(
      p + 2,
      `<</Type/StructElem/S/Sect/P 6 0 R/Pg ${p} 0 R/K[${Array.from({ length: per }, (_, k) => `${p + 3 + k} 0 R`).join(' ')}]>>`,
    );
    for (let k = 0; k < per; k++)
      packed(p + 3 + k, `<</Type/StructElem/S/P/P ${p + 2} 0 R/Pg ${p} 0 R/K ${k}>>`);
  }
  flush();
  if (nextStm !== xrefNum)
    throw new Error(`객체 스트림 수 불일치: ${nextStm - regular}/${objstmCount}`);
  // xref stream: W [1 4 2]. Object 0 is the head of the free list.
  const xrefOffset = offset;
  const rows = Buffer.alloc(size * 7);
  for (let n = 0; n < size; n++) {
    const o = n * 7;
    if (n === 0) {
      rows.writeUInt16BE(0xffff, o + 5);
      continue;
    }
    rows[o] = n === xrefNum ? 1 : type[n];
    rows.writeUInt32BE(n === xrefNum ? xrefOffset : f2[n], o + 1);
    rows.writeUInt16BE(type[n] === 2 ? f3[n] : 0, o + 5);
  }
  const xrefData = deflateSync(rows);
  write(
    `${xrefNum} 0 obj\n<</Type/XRef/Size ${size}/W[1 4 2]/Root 1 0 R/Filter/FlateDecode/Length ${xrefData.byteLength}>>\nstream\n`,
  );
  write(xrefData);
  write(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`);
  closeSync(fd);
  return offset;
}

/** Writes the synthetic document `id` to `path`. Returns the number of bytes written. */
export function writeSynthetic(id, path) {
  const spec = SYNTHETIC[id];
  if (!spec) throw new Error(`알 수 없는 합성 문서: ${id}`);
  if (spec.kind === 'image') return writeImagePdf(path, spec.pages);
  if (spec.kind === 'image-mixed') return writeImageMixedPdf(path, spec.pages);
  if (spec.kind === 'objstm') return writeObjStmPdf(path, spec.pages);
  return writeObjectPdf(path, spec.pages, spec.kind === 'object-annot');
}
