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
