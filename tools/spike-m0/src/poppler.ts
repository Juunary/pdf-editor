import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

/** Poppler(MuPDF 와 독립 구현) 교차 확인. 설치되지 않았으면 available=false. */
export function popplerVersion(): string | null {
  const r = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' });
  if (r.error) return null;
  return (r.stderr || r.stdout).split('\n')[0] ?? null;
}

/** 한 쪽 텍스트(UTF-8). */
export function popplerText(pdf: string, page: number): string {
  const r = spawnSync(
    'pdftotext',
    ['-enc', 'UTF-8', '-f', String(page), '-l', String(page), pdf, '-'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`pdftotext 실패: ${r.stderr}`);
  return r.stdout;
}

/** 한 쪽 렌더(PPM 바이트). prefix 에 임시 파일을 만들고 지운다. */
export function popplerRaster(pdf: string, page: number, prefix: string, dpi = 108): Buffer {
  const r = spawnSync('pdftoppm', [
    '-r',
    String(dpi),
    '-f',
    String(page),
    '-l',
    String(page),
    '-singlefile',
    pdf,
    prefix,
  ]);
  if (r.status !== 0) throw new Error(`pdftoppm 실패: ${r.stderr}`);
  const file = `${prefix}.ppm`;
  const bytes = readFileSync(file);
  rmSync(file);
  return bytes;
}

/** 한 쪽 PNG 저장(시각 확인용). */
export function popplerPng(pdf: string, page: number, prefix: string, dpi = 108): void {
  spawnSync('pdftoppm', [
    '-r',
    String(dpi),
    '-png',
    '-f',
    String(page),
    '-l',
    String(page),
    '-singlefile',
    pdf,
    prefix,
  ]);
}

/** 두 PPM(P6) 의 다른 픽셀 수. 크기가 다르면 -1. exclude(픽셀 좌표 [x0,y0,x1,y1]) 안은 세지 않는다. */
export function ppmDiff(a: Buffer, b: Buffer, exclude?: [number, number, number, number]): number {
  const parse = (buf: Buffer) => {
    const fields: string[] = [];
    let i = 0;
    while (fields.length < 4) {
      while (/\s/.test(String.fromCharCode(buf[i]!))) i++;
      let f = '';
      while (!/\s/.test(String.fromCharCode(buf[i]!))) f += String.fromCharCode(buf[i++]!);
      fields.push(f);
    }
    return { width: Number(fields[1]), height: Number(fields[2]), offset: i + 1 };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa.width !== pb.width || pa.height !== pb.height || a.length !== b.length) return -1;
  let diff = 0;
  for (let y = 0; y < pa.height; y++) {
    for (let x = 0; x < pa.width; x++) {
      if (exclude && x >= exclude[0] && x < exclude[2] && y >= exclude[1] && y < exclude[3])
        continue;
      const i = pa.offset + (y * pa.width + x) * 3;
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) diff++;
    }
  }
  return diff;
}

/** ppmDiff 의 차이 크기 지표: 다른 픽셀 수, 채널 차이가 threshold 를 넘는 수, 최대 채널 차이. */
export function ppmDiffStats(
  a: Buffer,
  b: Buffer,
  exclude?: [number, number, number, number],
  threshold = 96,
): { differing: number; strong: number; maxDelta: number } {
  const parse = (buf: Buffer) => {
    const fields: string[] = [];
    let i = 0;
    while (fields.length < 4) {
      while (/\s/.test(String.fromCharCode(buf[i]!))) i++;
      let f = '';
      while (!/\s/.test(String.fromCharCode(buf[i]!))) f += String.fromCharCode(buf[i++]!);
      fields.push(f);
    }
    return { width: Number(fields[1]), height: Number(fields[2]), offset: i + 1 };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa.width !== pb.width || pa.height !== pb.height || a.length !== b.length)
    return { differing: -1, strong: -1, maxDelta: -1 };
  let differing = 0;
  let strong = 0;
  let maxDelta = 0;
  for (let y = 0; y < pa.height; y++) {
    for (let x = 0; x < pa.width; x++) {
      if (exclude && x >= exclude[0] && x < exclude[2] && y >= exclude[1] && y < exclude[3])
        continue;
      const i = pa.offset + (y * pa.width + x) * 3;
      const d = Math.max(
        Math.abs(a[i]! - b[i]!),
        Math.abs(a[i + 1]! - b[i + 1]!),
        Math.abs(a[i + 2]! - b[i + 2]!),
      );
      if (d > 0) differing++;
      if (d > threshold) strong++;
      if (d > maxDelta) maxDelta = d;
    }
  }
  return { differing, strong, maxDelta };
}

export interface PopplerWord {
  box: [number, number, number, number];
  text: string;
}

/** `pdftotext -bbox` 단어 상자(pt, 페이지 좌상단 원점). */
export function popplerWords(pdf: string, page: number): PopplerWord[] {
  const r = spawnSync('pdftotext', ['-bbox', '-f', String(page), '-l', String(page), pdf, '-'], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  if (r.status !== 0) throw new Error(`pdftotext -bbox 실패: ${r.stderr}`);
  const out: PopplerWord[] = [];
  const re =
    /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
  for (const m of r.stdout.matchAll(re)) {
    out.push({ box: [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])], text: m[5]! });
  }
  return out;
}

/**
 * 편집 영역(pt, 페이지 좌상단 원점) 밖 단어를 원본·편집 결과에서 같은 글자열끼리 가장 가까운 것으로 짝지어
 * 위치 이동(상자 좌표 최대 차이)과 짝이 없는 단어 수를 센다.
 */
export function compareWordsOutside(
  before: PopplerWord[],
  after: PopplerWord[],
  exclusion: [number, number, number, number],
): { words: number; unmatched: number; maxShiftPt: number; shiftedOver01Pt: number } {
  const outside = (w: PopplerWord) =>
    w.box[2] < exclusion[0] ||
    w.box[0] > exclusion[2] ||
    w.box[3] < exclusion[1] ||
    w.box[1] > exclusion[3];
  const byText = new Map<string, PopplerWord[]>();
  for (const w of after.filter(outside)) {
    const list = byText.get(w.text) ?? [];
    list.push(w);
    byText.set(w.text, list);
  }
  const a = before.filter(outside);
  let unmatched = 0;
  let maxShiftPt = 0;
  let shiftedOver01Pt = 0;
  for (const w of a) {
    const cands = byText.get(w.text);
    if (!cands?.length) {
      unmatched++;
      continue;
    }
    const shift = Math.min(
      ...cands.map((c) => Math.max(...c.box.map((v, k) => Math.abs(v - w.box[k]!)))),
    );
    maxShiftPt = Math.max(maxShiftPt, shift);
    if (shift > 0.1) shiftedOver01Pt++;
  }
  return { words: a.length, unmatched, maxShiftPt, shiftedOver01Pt };
}
