import * as mupdf from 'mupdf';
import { createHash } from 'node:crypto';

/**
 * Object diff (PLAN.md section 8 "objects" axis). Two documents opened from the same original have the same object numbers, so
 * find objects within before's object number range whose dictionary string or raw stream bytes changed.
 */
export interface ObjectDiff {
  changed: number[];
  /** Number of objects newly created in after (number ≥ before.countObjects()) */
  added: number;
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/**
 * A copy that keeps object numbers (full save without garbage → reopen).
 * When a document that has `resolve()`d an image XObject with a compression filter is saved with `garbage=compact`, MuPDF 1.28.1
 * writes it without that image's stream (docs/m0-dod-xobject-redact-save.md 2.5). The document to be saved is not resolved directly.
 */
export function snapshot(doc: mupdf.PDFDocument): mupdf.PDFDocument {
  const buf = doc.saveToBuffer('');
  const bytes = buf.asUint8Array().slice();
  buf.destroy();
  return mupdf.Document.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument;
}

/** after may be a working document before saving (compared via a copy). */
export function diffObjects(before: mupdf.PDFDocument, after: mupdf.PDFDocument): ObjectDiff {
  const snap = snapshot(after);
  try {
    const changed: number[] = [];
    const n = before.countObjects();
    for (let i = 1; i < n; i++) {
      const a = before.newIndirect(i);
      const b = snap.newIndirect(i);
      let same = a.resolve().toString() === b.resolve().toString() && a.isStream() === b.isStream();
      if (same && a.isStream()) {
        same = sha(a.readRawStream().asUint8Array()) === sha(b.readRawStream().asUint8Array());
      }
      if (!same) changed.push(i);
    }
    return { changed, added: snap.countObjects() - n };
  } finally {
    snap.destroy();
  }
}

/**
 * Structure representation independent of object numbers. Follows indirect references (except Parent·P) and replaces streams with decoded and raw byte hashes.
 * Used to compare whether objects renumbered after a full save (garbage=compact) have the same content.
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

/** The canonical representation with only the raw hash removed (to distinguish cases where only the raw bytes differ due to recompression). */
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
