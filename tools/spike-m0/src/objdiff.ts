import * as mupdf from 'mupdf';
import { createHash } from 'node:crypto';

/**
 * 객체 diff(PLAN.md 8절 "객체" 축). 같은 원본에서 연 두 문서는 객체 번호가 같으므로,
 * before 의 객체 번호 범위에서 사전 문자열·원시 스트림 바이트가 달라진 객체를 찾는다.
 */
export interface ObjectDiff {
  changed: number[];
  /** after 에 새로 생긴 객체 수(번호 ≥ before.countObjects()) */
  added: number;
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export function diffObjects(before: mupdf.PDFDocument, after: mupdf.PDFDocument): ObjectDiff {
  const changed: number[] = [];
  const n = before.countObjects();
  for (let i = 1; i < n; i++) {
    const a = before.newIndirect(i);
    const b = after.newIndirect(i);
    let same = a.resolve().toString() === b.resolve().toString() && a.isStream() === b.isStream();
    if (same && a.isStream()) {
      same = sha(a.readRawStream().asUint8Array()) === sha(b.readRawStream().asUint8Array());
    }
    if (!same) changed.push(i);
  }
  return { changed, added: after.countObjects() - n };
}

/**
 * 객체 번호와 무관한 구조 표현. 간접 참조를 따라가며(Parent·P 제외) 스트림은 디코드·원시 바이트 해시로 바꾼다.
 * 전체 저장(garbage=compact) 후 번호가 바뀐 객체끼리 내용이 같은지 비교하는 데 쓴다.
 */
export function canonical(obj: mupdf.PDFObject, stack: number[] = []): unknown {
  if (obj.isIndirect()) {
    const num = obj.asIndirect();
    if (stack.includes(num)) return { cycle: stack.length - stack.indexOf(num) };
    const inner = canonical(obj.resolve(), [...stack, num]);
    if (!obj.isStream()) return inner;
    return {
      dict: inner,
      decoded: sha(obj.readStream().asUint8Array()),
      raw: sha(obj.readRawStream().asUint8Array()),
    };
  }
  if (obj.isDictionary()) {
    const out: Record<string, unknown> = {};
    const keys: string[] = [];
    obj.forEach((_v, k) => void keys.push(String(k)));
    for (const k of keys.sort()) {
      if (k === 'Parent' || k === 'P' || k === 'Length') continue;
      out[k] = canonical(obj.get(k), stack);
    }
    return out;
  }
  if (obj.isArray()) {
    const out: unknown[] = [];
    obj.forEach((v) => void out.push(canonical(v, stack)));
    return out;
  }
  return obj.toString();
}

export const canonicalHash = (obj: mupdf.PDFObject) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(obj)))
    .digest('hex');

/** canonical 표현에서 raw 해시만 뺀 것(재압축으로 원시 바이트만 다를 때 구분용). */
export function canonicalDecodedHash(obj: mupdf.PDFObject): string {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k]) => k !== 'raw')
          .map(([k, x]) => [k, strip(x)]),
      );
    }
    return v;
  };
  return createHash('sha256')
    .update(JSON.stringify(strip(canonical(obj))))
    .digest('hex');
}
