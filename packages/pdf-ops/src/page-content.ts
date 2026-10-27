import * as mupdf from 'mupdf';

/**
 * Direct objects (dictionaries, arrays) are copied recursively; indirect references are left as they are.
 * MuPDF shares a `put` direct object instead of copying it, so editing a child dictionary moved without a copy also changes the original.
 */
function copyDirect(doc: mupdf.PDFDocument, obj: mupdf.PDFObject): mupdf.PDFObject {
  if (obj.isIndirect()) return obj;
  if (obj.isDictionary()) {
    const copy = doc.newDictionary();
    obj.forEach((value, key) => void copy.put(key, copyDirect(doc, value)));
    return copy;
  }
  if (obj.isArray()) {
    const copy = doc.newArray();
    obj.forEach((value) => void copy.push(copyDirect(doc, value)));
    return copy;
  }
  return obj;
}

/** Direct copy of source (resolved if indirect). Copies down through child direct objects and keeps indirect references. */
function shallowCopy(doc: mupdf.PDFDocument, source: mupdf.PDFObject | null): mupdf.PDFObject {
  if (!source || source.isNull()) return doc.newDictionary();
  return copyDirect(doc, source.resolve());
}

/**
 * Replaces the Resources of holder (a page dictionary or Form XObject stream) with a direct copy dedicated to the holder and returns it.
 * Copies indirect objects (possibly shared with other pages/Forms), inherited values, and direct objects that may be shared with other dictionaries
 * (this prevents editing shared resources from changing other pages). The caller guarantees that holder itself is not shared.
 */
export function ownResources(
  doc: mupdf.PDFDocument,
  holder: mupdf.PDFObject,
  inherited: mupdf.PDFObject | null = null,
): mupdf.PDFObject {
  const own = holder.get('Resources');
  holder.put('Resources', shallowCopy(doc, own.isNull() ? inherited : own));
  return holder.get('Resources');
}

/** Replaces the dict[key] child dictionary (Font, XObject, etc.) with a direct copy dedicated to dict and returns it. */
export function ownSubdict(
  doc: mupdf.PDFDocument,
  dict: mupdf.PDFObject,
  key: string,
): mupdf.PDFObject {
  const sub = dict.get(key);
  dict.put(key, shallowCopy(doc, sub.isNull() ? null : sub));
  return dict.get(key);
}

/** Page-dedicated Resources dictionary (copied if inherited or a shared indirect object; see `ownResources`). */
export function ownPageResources(doc: mupdf.PDFDocument, page: mupdf.PDFPage): mupdf.PDFObject {
  const pageObj = page.getObject();
  const inherited = pageObj.getInheritable('Resources');
  return ownResources(doc, pageObj, inherited.isNull() ? null : inherited);
}

/** Picks a non-colliding resource name and registers it as subdict[name] = ref. */
export function putUniqueResource(
  subdict: mupdf.PDFObject,
  ref: mupdf.PDFObject,
  prefix: string,
): string {
  let n = 0;
  while (!subdict.get(`${prefix}${n}`).isNull()) n++;
  const name = `${prefix}${n}`;
  subdict.put(name, ref);
  return name;
}

/** Registers a font in the Font resource of holder (page dictionary or Form stream) and returns the resource name. */
export function addFontResource(
  doc: mupdf.PDFDocument,
  holder: mupdf.PDFObject,
  fontRef: mupdf.PDFObject,
  prefix = 'FE',
): string {
  const inherited = holder.getInheritable('Resources');
  const resources = ownResources(doc, holder, inherited.isNull() ? null : inherited);
  return putUniqueResource(ownSubdict(doc, resources, 'Font'), fontRef, prefix);
}

/** Registers a font in the page Font resource and returns a non-colliding resource name. */
export function addPageFontResource(
  doc: mupdf.PDFDocument,
  page: mupdf.PDFPage,
  fontRef: mupdf.PDFObject,
  prefix = 'FE',
): string {
  return addFontResource(doc, page.getObject(), fontRef, prefix);
}

/**
 * Wraps the original content in `q … Q` and appends the new content stream after it.
 * Keeps the graphics state left by the original streams (CTM, color, clip) from affecting the new content.
 * The new content is relative to the PDF default user space (origin at bottom left).
 */
export function appendPageContent(
  doc: mupdf.PDFDocument,
  page: mupdf.PDFPage,
  content: string,
): void {
  const pageObj = page.getObject();
  const original = pageObj.get('Contents');
  const contents = doc.newArray();
  contents.push(doc.addStream('q\n', {}));
  if (original.isArray()) {
    original.resolve().forEach((item) => {
      contents.push(item);
    });
  } else if (!original.isNull()) {
    contents.push(original);
  }
  contents.push(doc.addStream(`Q\n${content}`, {}));
  pageObj.put('Contents', contents);
}
