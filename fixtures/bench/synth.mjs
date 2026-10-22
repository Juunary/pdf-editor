#!/usr/bin/env node
// 벤치마크용 합성 PDF 생성기(M5 계약 D1·8절). 외부 의존성 없음. 같은 인자·시드면 같은 바이트가 나온다.
//
//   node fixtures/bench/synth.mjs --kind image   --pages 900  --seed 1 --out out/bench/synthetic-image-900.pdf
//   node fixtures/bench/synth.mjs --kind objects --pages 2000 --seed 2 --out out/bench/synthetic-objects-2000.pdf
//
// image  : 쪽마다 텍스트 1줄 + 비압축 잡음 이미지(약 787 KB, Flate stored 블록). 900쪽 = 저장 상한 시험용(약 675.7 MiB).
// objects: 쪽마다 텍스트 4줄 + 작은 간접 객체 `--objs-per-page`(기본 260)개를 쪽의 /PEBench 배열로 참조. 2000쪽 → 객체 ≥ 500k.
// heavy  : 첫 쪽은 한 줄 문단 12개 사이사이에 주석 줄(좌표·연산자 모양, 렌더·추출에 영향 없음)을 넣어 풀린 콘텐츠가
//          `--content-bytes`(기본 8 MiB)인 쪽, 나머지 쪽은 텍스트 4줄. 콘텐츠는 Flate. 큰 쪽 문단을 처음 고칠 때마다 쪽 콘텐츠가
//          저널에 남는 경로(docs/m5-followup.md 5.1)의 축소 사례다(코퍼스 kogl-mods-cpi-202609 9쪽은 풀린 8.9 MB).
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

/** xorshift32: 시드 고정 난수. */
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

// 번호: 1 Catalog, 2 Pages, 3 Font, 이후 쪽마다 [page, content, (image), extra...]
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
      // 주석 줄: 좌표 격자 값·연산자 모양(실제 콘텐츠처럼 압축된다). 문단 사이에 고르게 나눠 넣는다.
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
