import * as mupdf from 'mupdf';

/**
 * 직접 객체(사전·배열)는 재귀 복사하고 간접 참조는 그대로 둔다.
 * MuPDF 는 `put` 한 직접 객체를 복사하지 않고 공유하므로, 복사 없이 옮긴 하위 사전을 고치면 원본도 바뀐다.
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

/** source(간접이면 해석)의 직접 사본. 하위 직접 객체까지 복사하고 간접 참조는 유지한다. */
function shallowCopy(doc: mupdf.PDFDocument, source: mupdf.PDFObject | null): mupdf.PDFObject {
  if (!source || source.isNull()) return doc.newDictionary();
  return copyDirect(doc, source.resolve());
}

/**
 * holder(페이지 사전 또는 Form XObject 스트림)의 Resources 를 holder 전용 직접 사본으로 바꿔 돌려준다.
 * 간접 객체(다른 페이지·Form 과 공유 가능), 상속값, 다른 사전과 공유될 수 있는 직접 객체 모두 복사한다
 * (공유 리소스를 고쳐 다른 페이지가 바뀌는 일을 막는다). holder 자체가 공유되지 않는지는 호출자가 보장한다.
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

/** dict[key] 하위 사전(Font, XObject 등)을 dict 전용 직접 사본으로 바꿔 돌려준다. */
export function ownSubdict(
  doc: mupdf.PDFDocument,
  dict: mupdf.PDFObject,
  key: string,
): mupdf.PDFObject {
  const sub = dict.get(key);
  dict.put(key, shallowCopy(doc, sub.isNull() ? null : sub));
  return dict.get(key);
}

/** 페이지 전용 Resources 사전(상속·공유 간접 객체면 복사, `ownResources` 참고). */
export function ownPageResources(doc: mupdf.PDFDocument, page: mupdf.PDFPage): mupdf.PDFObject {
  const pageObj = page.getObject();
  const inherited = pageObj.getInheritable('Resources');
  return ownResources(doc, pageObj, inherited.isNull() ? null : inherited);
}

/** 겹치지 않는 리소스 이름을 골라 subdict[이름] = ref 로 등록한다. */
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

/** holder(페이지 사전 또는 Form 스트림)의 Font 리소스에 폰트를 등록하고 리소스 이름을 돌려준다. */
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

/** 페이지 Font 리소스에 폰트를 등록하고 겹치지 않는 리소스 이름을 돌려준다. */
export function addPageFontResource(
  doc: mupdf.PDFDocument,
  page: mupdf.PDFPage,
  fontRef: mupdf.PDFObject,
  prefix = 'FE',
): string {
  return addFontResource(doc, page.getObject(), fontRef, prefix);
}

/**
 * 원 콘텐츠를 `q … Q` 로 감싸고 새 콘텐츠 스트림을 뒤에 붙인다.
 * 원 스트림이 남긴 그래픽 상태(CTM, 색, 클립)가 새 콘텐츠에 영향을 주지 않게 한다.
 * 새 콘텐츠는 PDF 기본 사용자 공간(원점 좌하단) 기준이다.
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
