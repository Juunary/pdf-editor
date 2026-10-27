#!/usr/bin/env node
// Synthetic PDF generator for benchmarks (M5 contract D1·section 8). No external dependencies. The same arguments and seed produce the same bytes.
//
//   node fixtures/bench/synth.mjs --kind image   --pages 900  --seed 1 --out out/bench/synthetic-image-900.pdf
//   node fixtures/bench/synth.mjs --kind objects --pages 2000 --seed 2 --out out/bench/synthetic-objects-2000.pdf
//
// image  : per page 1 text line + an uncompressed noise image (about 787 KB, Flate stored blocks). 900 pages = for the save-limit test (about 675.7 MiB).
// objects: per page 4 text lines + `--objs-per-page` (default 260) small indirect objects referenced from the page's /PEBench array. 2000 pages → ≥ 500k objects.
// heavy  : the first page has comment lines (coordinate·operator shapes, no effect on render·extraction) inserted between 12 one-line paragraphs so that the decoded content is
//          `--content-bytes` (default 8 MiB); other pages have 4 text lines. Content is Flate. A scaled-down case of the path (docs/m5-followup.md 5.1) where the page content is
//          kept in the journal each time a paragraph on a large page is first edited (corpus kogl-mods-cpi-202609 page 9 is 8.9 MB decoded).
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { deflateSync } from 'node:zlib';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    kind: { type: 'string' },
    pages: { type: 'string' },
    seed: { type: 'string', default: '1' },
    out: { type: 'string' },
    'objs-per-page': { type: 'string', default: '260' },
    'image-bytes': { type: 'string', default: String(786_432) },
    'content-bytes': { type: 'string', default: String(8 * 1024 * 1024) },
  },
});
if (!args.kind || !args.pages || !args.out) {
  console.error('사용: --kind image|objects|heavy --pages N --out FILE [--seed N]');
  process.exit(2);
}
const kind = args.kind;
const pages = Number(args.pages);
const seed = Number(args.seed);
const objsPerPage = Number(args['objs-per-page']);
const imageBytes = Number(args['image-bytes']);
const contentBytes = Number(args['content-bytes']);

/** xorshift32: fixed-seed random numbers. */
function rng(s) {
  let x = (s || 1) >>> 0;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}
const rand = rng(seed * 2654435761);

mkdirSync(dirname(args.out), { recursive: true });
const fd = openSync(args.out, 'w');
const hash = createHash('sha256');
let offset = 0;
const offsets = [];
function put(chunk) {
  const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
  writeSync(fd, buf);
  hash.update(buf);
  offset += buf.length;
}
function obj(num, body) {
  offsets[num] = offset;
  put(`${num} 0 obj\n${body}\nendobj\n`);
}
function streamObj(num, dict, data) {
  offsets[num] = offset;
  put(`${num} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`);
  put(data);
  put('\nendstream\nendobj\n');
}

// Numbering: 1 Catalog, 2 Pages, 3 Font, then per page [page, content, (image), extra...]
const perPage = kind === 'image' ? 3 : kind === 'heavy' ? 2 : 2 + objsPerPage;
const first = (i) => 4 + i * perPage;
const total = 3 + pages * perPage;

put('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
obj(
  2,
  `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${first(i)} 0 R`).join(' ')}] >>`,
);
obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india'];
const line = (i, k) =>
  `Page ${i + 1} line ${k + 1} ${Array.from({ length: 8 }, () => WORDS[rand() % WORDS.length]).join(' ')}`;

for (let i = 0; i < pages; i++) {
  const n = first(i);
  if (kind === 'image') {
    const text = `BT /F1 12 Tf 72 720 Td (${line(i, 0)}) Tj ET\nq 468 0 0 468 72 150 cm /Im1 Do Q\n`;
    obj(
      n,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`,
    );
    streamObj(n + 1, '', Buffer.from(text, 'latin1'));
    const raw = Buffer.alloc(imageBytes);
    for (let p = 0; p < raw.length; p += 4) raw.writeUInt32LE(rand(), p);
    streamObj(
      n + 2,
      `/Type /XObject /Subtype /Image /Width 512 /Height ${Math.floor(imageBytes / 1536)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
      deflateSync(raw, { level: 0 }),
    );
  } else if (kind === 'heavy') {
    obj(
      n,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${n + 1} 0 R >>`,
    );
    const paras = i === 0 ? 12 : 4;
    const parts = [];
    for (let k = 0; k < paras; k++) {
      parts.push(`BT /F1 11 Tf 72 ${740 - k * (i === 0 ? 56 : 16)} Td (${line(i, k)}) Tj ET`);
      if (i !== 0) continue;
      // Comment lines: coordinate grid values·operator shapes (compress like real content). Spread evenly between paragraphs.
      const lines = [];
      for (let size = 0; size < contentBytes / paras; ) {
        const l = `% ${(rand() % 48) * 12.5} ${(rand() % 64) * 12.5} m ${(rand() % 48) * 12.5} ${(rand() % 64) * 12.5} l S`;
        lines.push(l);
        size += l.length + 1;
      }
      parts.push(lines.join('\n'));
    }
    const data = deflateSync(Buffer.from(parts.join('\n'), 'latin1'));
    streamObj(n + 1, '/Filter /FlateDecode', data);
  } else {
    const text = Array.from(
      { length: 4 },
      (_, k) => `BT /F1 11 Tf 72 ${720 - k * 16} Td (${line(i, k)}) Tj ET`,
    ).join('\n');
    const extra = Array.from({ length: objsPerPage }, (_, k) => `${n + 2 + k} 0 R`).join(' ');
    obj(
      n,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${n + 1} 0 R /PEBench [${extra}] >>`,
    );
    streamObj(n + 1, '', Buffer.from(text, 'latin1'));
    for (let k = 0; k < objsPerPage; k++) obj(n + 2 + k, `<< /K ${k} /S ${rand() % 100000} >>`);
  }
}

const xrefAt = offset;
put(`xref\n0 ${total + 1}\n0000000000 65535 f \n`);
const rows = [];
for (let n = 1; n <= total; n++) rows.push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
put(rows.join(''));
put(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
closeSync(fd);
console.log(
  JSON.stringify({ out: args.out, kind, pages, seed, objects: total, bytes: offset, sha256: hash.digest('hex') }),
);
