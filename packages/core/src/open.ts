import * as mupdf from 'mupdf';

/** PDF 바이트를 연다. PDF 가 아니면 예외. */
export function openPdf(bytes: Uint8Array | ArrayBuffer): mupdf.PDFDocument {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const pdf = doc.asPDF();
  if (!pdf) {
    doc.destroy();
    throw new Error('PDF 문서가 아님');
  }
  return pdf;
}
