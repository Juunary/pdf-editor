// 저장 힙 모델용 합성 PDF 생성기(docs/m5-heap.md 2절). WASM 을 거치지 않고 파일에 직접 써서 생성 자체가 힙을 쓰지 않는다.
// 같은 인자면 같은 바이트가 나온다(시드 고정).
import { closeSync, openSync, writeSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

/** 합성 문서 종류. 이름 → 생성 함수 인자. 매니페스트·결과 표의 id 로 쓴다. */
export const SYNTHETIC = {
  'synth-image-100': { kind: 'image', pages: 100 },
  'synth-image-300': { kind: 'image', pages: 300 },
  'synth-image-500': { kind: 'image', pages: 500 },
  'synth-image-700': { kind: 'image', pages: 700 },
  'synth-image-900': { kind: 'image', pages: 900 },
  // 상한 경계(2 GiB) 확인용. 실패(over-limit 실제)도 판정 분모에 들어간다.
  'synth-image-800': { kind: 'image', pages: 800 },
  'synth-image-1000': { kind: 'image', pages: 1000 },
  'synth-image-1100': { kind: 'image', pages: 1100 },
  'synth-image-1200': { kind: 'image', pages: 1200 },
  'synth-object-500': { kind: 'object', pages: 500 },
  'synth-object-1000': { kind: 'object', pages: 1000 },
  'synth-object-2000': { kind: 'object', pages: 2000 },
  // 계약 8절 대용량 문서 합성 대체(검증 전용, 적합에서 뺀다). 적합용과 다른 구성으로 만들어 외삽을 본다.
  'large-image-mixed': { kind: 'image-mixed', pages: 160 },
  'large-object-4000': { kind: 'object-annot', pages: 4000 },
};

/** 적합에서 빼고 검증에만 쓰는 대용량 문서(계약 4.2). */
export const HOLDOUT = new Set(['large-image-mixed', 'large-object-4000']);

/** 이미지 위주 시드(`tools/spike-m0/src/save-bench.ts` writeLargePdf 와 같은 값, 같은 바이트). */
export const IMAGE_SEED = 0x12345678;
/** 객체 위주 문서의 쪽당 구조 요소 수. 2,000쪽이면 객체 약 50.4만 개. */
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
 * 이미지 위주: 쪽마다 압축 불가 잡음 이미지(512×512 RGB, FlateDecode 약 787 KB) + 텍스트 1줄.
 * `docs/m0-dod-xobject-redact-save.md` 3.2 대형 문서와 같은 생성 방식.
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
 * 객체 위주(태그 문서 모양): 쪽마다 텍스트 줄 `STRUCT_PER_PAGE` 개(각 줄 MCID) + 줄마다 /P 구조 요소 객체 1개.
 * 객체 = 카탈로그·쪽 트리·폰트·구조 루트·부모 트리 + 쪽마다(쪽 + 콘텐츠 + 구조 요소 248 + 쪽 구조 요소 1).
 */
export function writeObjectPdf(path, pages, annots = false) {
  const { write, obj, finish } = writer(path);
  const per = STRUCT_PER_PAGE;
  // 쪽, 콘텐츠, 쪽 구조 요소(/Sect), 줄 구조 요소 + (annots) 링크 주석 2개·동작 2개
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
  // 부모 트리: 쪽 i → 줄 구조 요소 배열. 숫자 트리 하나에 모두 둔다(MuPDF 는 열 때 읽지 않는다).
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
 * 이미지 혼합: 쪽마다 잡음 이미지 1개(512×512, 압축 불가) + 압축이 잘 되는 그러데이션 이미지 1개(1024×1024 RGB, 원 스트림
 * 작음·디코드 3 MiB) + 텍스트 40줄. 원 스트림 /Length 와 디코드 크기가 크게 다른 문서다.
 */
export function writeImageMixedPdf(path, pages) {
  const { write, obj, finish } = writer(path);
  const per = 5; // 쪽, 콘텐츠, 잡음 이미지, 그러데이션 이미지, (예비) 쪽마다 고유 폰트 사전
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

/** id 의 합성 문서를 `path` 에 쓴다. 쓴 바이트 수. */
export function writeSynthetic(id, path) {
  const spec = SYNTHETIC[id];
  if (!spec) throw new Error(`알 수 없는 합성 문서: ${id}`);
  if (spec.kind === 'image') return writeImagePdf(path, spec.pages);
  if (spec.kind === 'image-mixed') return writeImageMixedPdf(path, spec.pages);
  return writeObjectPdf(path, spec.pages, spec.kind === 'object-annot');
}
