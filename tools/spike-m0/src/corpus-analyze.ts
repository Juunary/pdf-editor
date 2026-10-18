import * as mupdf from 'mupdf';
import {
  concatBytes,
  listRedactAnnots,
  listXObjectUsages,
  parseContentOps,
  type ContentOp,
  type XObjectUsage,
} from '@pdf-editor/pdf-ops';
import type { Rect } from '@pdf-editor/shared-types';

/**
 * 코퍼스 문서 구조 분석(docs/m0-corpus-recheck.md 2절·6절). M1 원본 연결(SourceMap) 난이도 근거:
 * 콘텐츠 스트림 토크나이저 실패, Form XObject 안 텍스트 비율·공유, 폰트 매핑 유형, 태그·주석.
 *
 * 저장하지 않는 분석 전용 문서에서만 쓴다. 이미지 XObject 는 `resolve()` 하지 않는다(MuPDF 1.28.1 F3).
 */

const TEXT_SHOW = new Set(['Tj', 'TJ', "'", '"']);

export interface OpCounts {
  ops: number;
  textShow: number;
  bt: number;
  do: number;
  /** BDC/BMC 중 MCID 를 가진 것(태그 PDF 구조 연결) */
  mcid: number;
  inlineImages: number;
}

const zeroCounts = (): OpCounts => ({
  ops: 0,
  textShow: 0,
  bt: 0,
  do: 0,
  mcid: 0,
  inlineImages: 0,
});

function countOps(ops: ContentOp[]): OpCounts {
  const c = zeroCounts();
  for (const op of ops) {
    c.ops++;
    if (TEXT_SHOW.has(op.op)) c.textShow++;
    else if (op.op === 'BT') c.bt++;
    else if (op.op === 'Do') c.do++;
    else if (op.op === 'BI') c.inlineImages++;
    else if (
      (op.op === 'BDC' || op.op === 'BMC') &&
      op.operands.some((t) => t.kind === 'name' && t.value === 'MCID')
    )
      c.mcid++;
  }
  return c;
}

const addCounts = (a: OpCounts, b: OpCounts, times = 1) => {
  for (const k of Object.keys(a) as (keyof OpCounts)[]) a[k] += b[k] * times;
};

function streams(contents: mupdf.PDFObject): mupdf.PDFObject[] {
  const out: mupdf.PDFObject[] = [];
  if (contents.isArray()) contents.resolve().forEach((s) => void out.push(s));
  else if (!contents.isNull()) out.push(contents);
  return out;
}

export interface FormInfo {
  objectNumber: number;
  usages: number;
  pages: number[];
  maxDepth: number;
  counts: OpCounts | null;
  parseError: string | null;
  /** L1: 자체 /Resources 없음 */
  noResources: boolean;
  /** L2: /StructParents 또는 콘텐츠 MCID */
  structParents: boolean;
  /** L7: /OC */
  optionalContent: boolean;
  /** 페이지 사용자 공간(PDF 좌표) BBox, 쪽별 첫 사용 위치 */
  pageBoxes: { pageIndex: number; box: Rect }[];
}

export interface FontInfo {
  key: string;
  subtype: string;
  baseFont: string;
  /** Type0: CMap 이름, 단순 폰트: 인코딩 이름 또는 'dict'(Differences) */
  encoding: string | null;
  differences: boolean;
  descendant: string | null;
  embedded: boolean;
  fontFile: string | null;
  subsetTagged: boolean;
  toUnicode: boolean;
}

export interface DocAnalysis {
  pageCount: number;
  rotatedPages: number;
  encrypted: boolean;
  producer: string;
  creator: string;
  tagged: { markInfoMarked: boolean; structTreeRoot: boolean };
  optionalContent: boolean;
  content: {
    /** Contents 배열(스트림 2개 이상) 쪽 수 */
    multiStreamPages: number;
    /** 이어붙인 콘텐츠 토크나이저 실패(L6) */
    parseFailures: { pageIndex: number; error: string }[];
    /** 스트림 단독으로는 실패하나 이어붙이면 성공: 연산자가 Contents 배열 경계에 걸침(L6) */
    boundarySplitPages: number;
    page: OpCounts;
    /** Form 안 연산(사용 위치마다 반복 계수) */
    inForms: OpCounts;
  };
  forms: {
    usages: number;
    unique: number;
    /** 2곳 이상 사용 */
    shared: number;
    withText: number;
    sharedWithText: number;
    pagesWithForms: number;
    pagesWithTextForms: number;
    maxDepth: number;
    walkFailures: { pageIndex: number; error: string }[];
    L1NoResources: number;
    L2StructParents: number;
    L5DepthLimit: number;
    L6ParseFailures: number;
    L7OptionalContent: number;
    /** 텍스트가 있는 공유 Form 상위 5개 */
    sharedTextSample: Omit<FormInfo, 'pageBoxes'>[];
  };
  fonts: {
    total: number;
    bySubtype: Record<string, number>;
    notEmbedded: number;
    noToUnicode: number;
    type3: number;
    identityH: number;
    simpleWithDifferences: number;
    /** ToUnicode 없는 비표준 인코딩 폰트(문자 매핑 복원 곤란 후보) */
    mappingRisk: number;
  };
  annots: { redact: number; link: number; widget: number; other: number };
  /** 쪽별 Form 사용 위치(텍스트 있는 Form 만, 문단 판정용) */
  textFormBoxes: Record<number, { objectNumber: number; box: Rect; depth: number }[]>;
  formTable: Record<number, FormInfo>;
  fontTable: FontInfo[];
  analyzeMs: number;
}

const STANDARD_ENCODINGS = ['WinAnsiEncoding', 'MacRomanEncoding', 'StandardEncoding'];

/** ToUnicode 없이 비표준 인코딩(Type0·Type3·Differences·기타 CMap)인 폰트: 문자 매핑 복원 곤란 후보. */
export function isMappingRisk(f: FontInfo): boolean {
  if (f.toUnicode) return false;
  if (f.subtype === 'Type0' || f.subtype === 'Type3' || f.differences) return true;
  return f.encoding !== null && f.encoding !== 'dict' && !STANDARD_ENCODINGS.includes(f.encoding);
}

/** 폰트 이름에서 서브셋 태그(ABCDEF+)를 뗀다. */
export const stripSubsetTag = (name: string) => name.replace(/^[A-Z]{6}\+/, '');

function inspectFont(key: string, font: mupdf.PDFObject): FontInfo {
  const name = (o: mupdf.PDFObject) => (o.isName() ? o.asName() : '');
  const subtype = name(font.get('Subtype'));
  const enc = font.get('Encoding');
  let descendant: string | null = null;
  let fd = font.get('FontDescriptor');
  if (subtype === 'Type0') {
    const d = font.get('DescendantFonts').get(0);
    descendant = name(d.get('Subtype'));
    fd = d.get('FontDescriptor');
  }
  const fontFile = fd.isNull()
    ? null
    : (['FontFile', 'FontFile2', 'FontFile3'].find((k) => !fd.get(k).isNull()) ?? null);
  const baseFont = name(font.get('BaseFont'));
  return {
    key,
    subtype,
    baseFont,
    encoding: enc.isName()
      ? enc.asName()
      : enc.isDictionary()
        ? 'dict'
        : enc.isStream()
          ? 'stream'
          : null,
    differences: enc.isDictionary() && !enc.get('Differences').isNull(),
    descendant,
    embedded: fontFile !== null || subtype === 'Type3',
    fontFile,
    subsetTagged: /^[A-Z]{6}\+/.test(baseFont),
    toUnicode: !font.get('ToUnicode').isNull(),
  };
}

/** 리소스 사전의 Font 를 모은다(간접 객체 번호로 중복 제거). */
function collectFonts(resources: mupdf.PDFObject, out: Map<string, FontInfo>): void {
  const fonts = resources.get('Font');
  if (!fonts.isDictionary()) return;
  fonts.forEach((f, k) => {
    const key = f.isIndirect() ? `obj${f.asIndirect()}` : `direct:${String(k)}:${out.size}`;
    if (out.has(key)) return;
    try {
      out.set(key, inspectFont(key, f));
    } catch {
      // 손상된 폰트 사전은 건너뛴다(분석 전용)
    }
  });
}

export function analyzeDocument(doc: mupdf.PDFDocument): DocAnalysis {
  const t0 = performance.now();
  const pageCount = doc.countPages();
  const trailer = doc.getTrailer();
  const root = trailer.get('Root');
  const markInfo = root.get('MarkInfo');
  const a: DocAnalysis = {
    pageCount,
    rotatedPages: 0,
    encrypted: !trailer.get('Encrypt').isNull(),
    producer: doc.getMetaData('info:Producer') ?? '',
    creator: doc.getMetaData('info:Creator') ?? '',
    tagged: {
      markInfoMarked:
        markInfo.isDictionary() && markInfo.get('Marked').isBoolean()
          ? markInfo.get('Marked').asBoolean()
          : false,
      structTreeRoot: !root.get('StructTreeRoot').isNull(),
    },
    optionalContent: !root.get('OCProperties').isNull(),
    content: {
      multiStreamPages: 0,
      parseFailures: [],
      boundarySplitPages: 0,
      page: zeroCounts(),
      inForms: zeroCounts(),
    },
    forms: {
      usages: 0,
      unique: 0,
      shared: 0,
      withText: 0,
      sharedWithText: 0,
      pagesWithForms: 0,
      pagesWithTextForms: 0,
      maxDepth: 0,
      walkFailures: [],
      L1NoResources: 0,
      L2StructParents: 0,
      L5DepthLimit: 0,
      L6ParseFailures: 0,
      L7OptionalContent: 0,
      sharedTextSample: [],
    },
    fonts: {
      total: 0,
      bySubtype: {},
      notEmbedded: 0,
      noToUnicode: 0,
      type3: 0,
      identityH: 0,
      simpleWithDifferences: 0,
      mappingRisk: 0,
    },
    annots: { redact: 0, link: 0, widget: 0, other: 0 },
    textFormBoxes: {},
    formTable: {},
    fontTable: [],
    analyzeMs: 0,
  };
  const fonts = new Map<string, FontInfo>();
  const forms = new Map<number, FormInfo>();

  const formInfo = (u: XObjectUsage): FormInfo => {
    let f = forms.get(u.objectNumber);
    if (f) return f;
    const obj = doc.newIndirect(u.objectNumber);
    let counts: OpCounts | null = null;
    let parseError: string | null = null;
    try {
      counts = countOps(parseContentOps(obj.readStream().asUint8Array().slice()));
    } catch (e) {
      parseError = String(e);
    }
    const res = obj.get('Resources');
    if (res.isDictionary()) collectFonts(res, fonts);
    f = {
      objectNumber: u.objectNumber,
      usages: 0,
      pages: [],
      maxDepth: 0,
      counts,
      parseError,
      noResources: res.isNull(),
      structParents: !obj.get('StructParents').isNull() || (counts?.mcid ?? 0) > 0,
      optionalContent: !obj.get('OC').isNull(),
      pageBoxes: [],
    };
    forms.set(u.objectNumber, f);
    return f;
  };

  for (let p = 0; p < pageCount; p++) {
    const pageObj = doc.findPage(p);
    const rot = pageObj.getInheritable('Rotate');
    if (!rot.isNull() && rot.asNumber() % 360 !== 0) a.rotatedPages++;
    const res = pageObj.getInheritable('Resources');
    if (res.isDictionary()) collectFonts(res, fonts);

    const parts = streams(pageObj.get('Contents')).map((s) => {
      try {
        return s.readStream().asUint8Array().slice();
      } catch {
        return new Uint8Array();
      }
    });
    if (parts.length > 1) a.content.multiStreamPages++;
    try {
      addCounts(a.content.page, countOps(parseContentOps(concatBytes(parts, 0x0a))));
      if (parts.length > 1) {
        const alone = parts.some((part) => {
          try {
            parseContentOps(part);
            return false;
          } catch {
            return true;
          }
        });
        if (alone) a.content.boundarySplitPages++;
      }
    } catch (e) {
      a.content.parseFailures.push({ pageIndex: p, error: String(e) });
    }

    let usages: XObjectUsage[] = [];
    try {
      usages = listXObjectUsages(doc, p);
    } catch (e) {
      a.forms.walkFailures.push({ pageIndex: p, error: String(e) });
    }
    const formUsages = usages.filter((u) => u.subtype === 'Form' && u.objectNumber);
    if (formUsages.length) a.forms.pagesWithForms++;
    let pageHasTextForm = false;
    for (const u of formUsages) {
      a.forms.usages++;
      const f = formInfo(u);
      f.usages++;
      if (!f.pages.includes(p)) {
        f.pages.push(p);
        f.pageBoxes.push({ pageIndex: p, box: u.pageBox });
      }
      f.maxDepth = Math.max(f.maxDepth, u.path.length);
      a.forms.maxDepth = Math.max(a.forms.maxDepth, u.path.length);
      if (f.counts) addCounts(a.content.inForms, f.counts);
      if ((f.counts?.textShow ?? 0) > 0) {
        pageHasTextForm = true;
        (a.textFormBoxes[p] ??= []).push({
          objectNumber: f.objectNumber,
          box: u.pageBox,
          depth: u.path.length,
        });
      }
    }
    if (pageHasTextForm) a.forms.pagesWithTextForms++;

    const annots = pageObj.get('Annots');
    if (annots.isArray()) {
      annots.resolve().forEach((an) => {
        const st = an.get('Subtype');
        const s = st.isName() ? st.asName() : '';
        if (s === 'Redact') a.annots.redact++;
        else if (s === 'Link') a.annots.link++;
        else if (s === 'Widget') a.annots.widget++;
        else a.annots.other++;
      });
    }
  }

  a.forms.unique = forms.size;
  for (const f of forms.values()) {
    const hasText = (f.counts?.textShow ?? 0) > 0;
    if (f.usages >= 2) a.forms.shared++;
    if (hasText) a.forms.withText++;
    if (hasText && f.usages >= 2) a.forms.sharedWithText++;
    if (f.noResources) a.forms.L1NoResources++;
    if (f.structParents) a.forms.L2StructParents++;
    if (f.maxDepth >= 8) a.forms.L5DepthLimit++;
    if (f.parseError) a.forms.L6ParseFailures++;
    if (f.optionalContent) a.forms.L7OptionalContent++;
  }
  a.forms.sharedTextSample = [...forms.values()]
    .filter((f) => f.usages >= 2 && (f.counts?.textShow ?? 0) > 0)
    .sort((x, y) => y.usages - x.usages)
    .slice(0, 5)
    .map(({ pageBoxes, ...rest }) => (void pageBoxes, { ...rest, pages: rest.pages.slice(0, 20) }));
  a.formTable = Object.fromEntries([...forms].map(([k, v]) => [k, v]));

  for (const f of fonts.values()) {
    a.fonts.total++;
    a.fonts.bySubtype[f.subtype] = (a.fonts.bySubtype[f.subtype] ?? 0) + 1;
    if (!f.embedded) a.fonts.notEmbedded++;
    if (!f.toUnicode) a.fonts.noToUnicode++;
    if (f.subtype === 'Type3') a.fonts.type3++;
    if (f.encoding === 'Identity-H' || f.encoding === 'Identity-V') a.fonts.identityH++;
    if (f.differences) a.fonts.simpleWithDifferences++;
    if (isMappingRisk(f)) a.fonts.mappingRisk++;
  }
  a.fontTable = [...fonts.values()];
  a.annots.redact = listRedactAnnots(doc).total;
  a.analyzeMs = performance.now() - t0;
  return a;
}
