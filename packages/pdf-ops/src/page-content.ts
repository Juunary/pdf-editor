import * as mupdf from 'mupdf';

/**
 * 페이지 자체 Resources 사전을 돌려준다. 상속받은 Resources 만 있으면 복사해 페이지에 둔다
 * (부모 Pages 의 공유 리소스를 고쳐 다른 페이지가 바뀌는 일을 막는다).
 */
export function ownPageResources(doc: mupdf.PDFDocument, page: mupdf.PDFPage): mupdf.PDFObject {
  const pageObj = page.getObject();
  const own = pageObj.get('Resources');
  if (!own.isNull()) return own.resolve();
  const inherited = pageObj.getInheritable('Resources');
  const copy = doc.newDictionary();
  if (!inherited.isNull()) {
    inherited.resolve().forEach((value, key) => {
      copy.put(key, value);
    });
  }
  pageObj.put('Resources', copy);
  return pageObj.get('Resources').resolve();
}

/** 페이지 Font 리소스에 폰트를 등록하고 겹치지 않는 리소스 이름을 돌려준다. */
export function addPageFontResource(
  doc: mupdf.PDFDocument,
  page: mupdf.PDFPage,
  fontRef: mupdf.PDFObject,
  prefix = 'FE',
): string {
  const resources = ownPageResources(doc, page);
  let fonts = resources.get('Font');
  if (fonts.isNull()) {
    resources.put('Font', doc.newDictionary());
    fonts = resources.get('Font');
  }
  fonts = fonts.resolve();
  let n = 0;
  while (!fonts.get(`${prefix}${n}`).isNull()) n++;
  const name = `${prefix}${n}`;
  fonts.put(name, fontRef);
  return name;
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
