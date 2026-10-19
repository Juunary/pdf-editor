/** 편집 세션이 쓰는 순수 보조 함수(기하·경고·폴백 폰트 바이트·PDF/A 선언 검사). */
import * as mupdf from 'mupdf';
import type {
  EditWarning,
  EditWarningKind,
  LayoutParagraph,
  PageLayout,
  Rect,
  ReflowSummary,
} from '@pdf-editor/shared-types';

export function unionRect(a: Rect, b: Rect): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

export function inflateRect(r: Rect, margin: number): Rect {
  return [r[0] - margin, r[1] - margin, r[2] + margin, r[3] + margin];
}

/** 겹치지 않으면 null. */
export function intersectRect(a: Rect, b: Rect): Rect | null {
  const r: Rect = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  return r[2] > r[0] && r[3] > r[1] ? r : null;
}

function containsRect(outer: Rect, inner: Rect, tolerance = 0): boolean {
  return (
    inner[0] >= outer[0] - tolerance &&
    inner[1] >= outer[1] - tolerance &&
    inner[2] <= outer[2] + tolerance &&
    inner[3] <= outer[3] + tolerance
  );
}

/** FontManager 가 정하는 경고. 현재 글자 기준으로 매번 다시 정해지므로 계획 단계 경고를 대체한다. */
const FONT_WARNING_KINDS: ReadonlySet<EditWarningKind> = new Set<EditWarningKind>([
  'font-fallback',
  'glyph-missing',
  'synthetic-style',
]);

/** core 가 리플로우 결과로 직접 정하는 경고. */
const CORE_WARNING_KINDS: ReadonlySet<EditWarningKind> = new Set<EditWarningKind>([
  'overflow-clipped',
  'area-overlaps-content',
]);

/** 영역 상한 밖으로 나간 부분이 렌더에서 잘린다(계약 5.4 `keep`·상한에 막힌 `expand`). */
const CLIP_TOLERANCE_PT = 0.5;
/** 겹침으로 보는 최소 변 길이(pt). 맞닿은 테두리를 겹침으로 세지 않는다. */
const OVERLAP_MIN_PT = 0.5;

/** `contentBox` 가 `areaLimit` 밖으로 나간 부분(위·아래·왼쪽·오른쪽 띠). */
function outsideStrips(box: Rect, limit: Rect): Rect[] {
  const strips: Rect[] = [];
  if (box[1] < limit[1] - CLIP_TOLERANCE_PT) strips.push([box[0], box[1], box[2], limit[1]]);
  if (box[3] > limit[3] + CLIP_TOLERANCE_PT) strips.push([box[0], limit[3], box[2], box[3]]);
  if (box[0] < limit[0] - CLIP_TOLERANCE_PT) strips.push([box[0], box[1], limit[0], box[3]]);
  if (box[2] > limit[2] + CLIP_TOLERANCE_PT) strips.push([limit[2], box[1], box[2], box[3]]);
  return strips;
}

export interface CoreWarningInput {
  summary: ReflowSummary;
  areaLimit: Rect;
  layout: PageLayout;
  /** 편집 대상 문단(레이아웃 id). 다른 내용과의 겹침 판정에서 뺀다. */
  paragraphId: number;
  /** 원 문단 bbox. 이 상자를 덮는 표·도형(배경)은 겹침으로 세지 않는다. */
  originalBox: Rect;
}

/**
 * 리플로우 결과로 정하는 경고(계약 5.1·5.4): `overflow-clipped`(배치 상자가 영역 상한 밖),
 * `area-overlaps-content`(쓴 영역이 다른 문단·표·도형과 겹침, 원 문단 bbox 를 덮는 표·도형은 제외).
 */
export function coreWarnings(input: CoreWarningInput): EditWarning[] {
  const { summary, areaLimit, layout, paragraphId, originalBox } = input;
  const warnings: EditWarning[] = [];
  if (!containsRect(areaLimit, summary.contentBox, CLIP_TOLERANCE_PT)) {
    warnings.push({
      kind: 'overflow-clipped',
      message: '영역 상한(쪽·Form 경계) 밖으로 나간 글자는 표시되지 않습니다.',
      rects: outsideStrips(summary.contentBox, areaLimit),
    });
  }
  const others: Rect[] = [
    ...layout.paragraphs.filter((p: LayoutParagraph) => p.id !== paragraphId).map((p) => p.bbox),
    ...[...layout.tables, ...layout.figures]
      .map((t) => t.bbox)
      .filter((box) => !containsRect(box, originalBox)),
  ];
  const significant = (r: Rect | null): r is Rect =>
    r !== null && r[2] - r[0] > OVERLAP_MIN_PT && r[3] - r[1] > OVERLAP_MIN_PT;
  const overlaps: Rect[] = [];
  for (const box of others) {
    // 원 문단이 이미 겹쳐 있던 상자(좁은 행간·그림 위 글)는 영역을 넓혀서 생긴 겹침이 아니다.
    if (significant(intersectRect(originalBox, box))) continue;
    const hit = intersectRect(summary.area, box);
    if (significant(hit)) overlaps.push(hit);
  }
  if (overlaps.length > 0) {
    warnings.push({
      kind: 'area-overlaps-content',
      message: '편집 영역이 다른 글자·표·도형과 겹칩니다.',
      rects: overlaps,
    });
  }
  return warnings;
}

/**
 * 초안 경고 목록. 계획 단계 경고 중 폰트·core 판정 종류는 현재 글자 기준의 새 결과로 바꾼다
 * (글자를 지우면 `glyph-missing` 이 사라진다). 같은 종류는 하나로 합친다.
 */
export function mergeWarnings(
  planWarnings: EditWarning[],
  fontWarnings: EditWarning[],
  extra: EditWarning[],
): EditWarning[] {
  const kept = planWarnings.filter(
    (w) => !FONT_WARNING_KINDS.has(w.kind) && !CORE_WARNING_KINDS.has(w.kind),
  );
  const merged = new Map<EditWarningKind, EditWarning>();
  for (const w of [...kept, ...fontWarnings, ...extra]) {
    const prior = merged.get(w.kind);
    merged.set(w.kind, prior ? { ...prior, rects: [...prior.rects, ...w.rects] } : w);
  }
  return [...merged.values()];
}

/**
 * 폴백 폰트 바이트에 salt 를 덧붙인 사본. MuPDF `addFont` 는 폰트 바이트 다이제스트를 키로 문서의 폰트 리소스 표에서
 * 기존 폰트 객체를 찾아 돌려주는데, 저널이 그 객체를 되돌려(abandon·undo) xref 에서 지워도 표 항목은 남는다. 같은
 * 바이트로 다시 넣으면 끊긴 참조가 돌아온다(docs/m3-core.md 2.3). 바이트가 다르면 새 객체가 생기므로 호출마다 salt 를
 * 바꾼다. TrueType 은 마지막 테이블 뒤의 여분 바이트를 무시한다. salt 0 은 원본 그대로(복사 없음).
 */
export function saltedFontBytes(bytes: Uint8Array, salt: number): Uint8Array {
  if (salt === 0) return bytes;
  const out = new Uint8Array(bytes.length + 4);
  out.set(bytes);
  new DataView(out.buffer).setUint32(bytes.length, salt >>> 0);
  return out;
}

/** /Metadata(XMP)에 PDF/A 선언(`pdfaid:part`)이 있는지(계약 5.6). 읽지 못하면 false. */
export function declaresPdfA(doc: mupdf.PDFDocument): boolean {
  try {
    const metadata = doc.getTrailer().get('Root', 'Metadata');
    if (!metadata.isStream()) return false;
    const buffer = metadata.readStream();
    try {
      return /pdfaid:(part|conformance)/.test(buffer.asString());
    } finally {
      buffer.destroy();
    }
  } catch {
    return false;
  }
}

/**
 * trailer /Info 가 해석되는 사전이 아니면 새 빈 사전을 만든다. 작업(저널) 밖에서만 부른다(계약 D9, docs/m3-core.md 2.2).
 * 객체를 추가하면 MuPDF 가 새 xref 구간을 만들어 trailer 도 새 사전이 되므로, 객체를 먼저 만들고 `getTrailer()` 를
 * 그 뒤에 부른다(먼저 받아 둔 trailer 에 넣으면 현재 trailer 에 반영되지 않는다, docs/m3-core.md 2.2).
 */
export function ensureInfoDictionary(doc: mupdf.PDFDocument): void {
  // isDictionary 는 간접 참조를 따라간다. 끊긴 참조·null 이면 false.
  const info = doc.getTrailer().get('Info');
  if (info.isDictionary()) {
    // 직접 사전이면 trailer 변경이 저널에 기록되지 않아 undo 가 닿지 않는다. 간접 객체로 바꿔 둔다.
    if (!info.isIndirect()) {
      const ref = doc.addObject(info);
      doc.getTrailer().put('Info', ref);
    }
    return;
  }
  const created = doc.addObject(doc.newDictionary());
  doc.getTrailer().put('Info', created);
}
