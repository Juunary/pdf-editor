/** 편집 세션이 쓰는 순수 보조 함수(기하·경고·폴백 폰트 바이트·PDF/A 선언 검사). */
import * as mupdf from 'mupdf';
import type {
  EditWarning,
  EditWarningKind,
  LayoutParagraph,
  PageLayout,
  PaintColor,
  PathEdit,
  PathEditPlan,
  RGB,
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

/** 영역 상한 밖으로 나간 부분이 렌더에서 잘린다(계약 5.4: 자동 확장이 상한에 막힌 초과). */
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

/** 표 괘선으로 볼 수 있는 가는 패스의 짧은 변 상한(pt). */
const RULE_MAX_THICKNESS_PT = 3;
/** 색 채널을 "같다"로 보는 8비트 반올림 오차. */
const RGB_EPSILON = 0.5 / 255;

function sameRgb(a: RGB, b: RGB): boolean {
  return a.every((v, i) => Math.abs(v - b[i]!) <= RGB_EPSILON);
}

/**
 * 새 색을 원래 색공간 계열로 쓸 수 없어 DeviceRGB 로 바꿔야 하는가(계약 D3). 성분 수 1·3·4 의 Device 계열은 그대로
 * 쓰되 Gray 에 채도가 있으면 불가, Separation·DeviceN·Indexed·Lab 은 항상 불가. 원래 rgb 근사와 같은 색은 쓰지 않는
 * 채널이라 해당 없음. pdf-ops 의 실제 쓰기 결정의 근사이며, pdf-ops 가 같은 종류 경고를 주면 합쳐진다.
 */
function needsSpaceChange(old: PaintColor | null, next: RGB | null): boolean {
  if (!old || !next) return false;
  if (old.rgb && sameRgb(old.rgb, next)) return false;
  if (/Separation|DeviceN|Indexed|Lab/i.test(old.space)) return true;
  if (old.values.length === 1) return Math.max(...next) - Math.min(...next) > RGB_EPSILON;
  return false;
}

/**
 * 패스 편집 요청으로 core 가 정하는 경고(계약 4.2): `color-space-changed`(D3 근사), `table-rule-removed`(D2: 괘선 표
 * 안의 가는 패스를 지움, 레이아웃 기반 근사). `path-clipped` 는 칠하기 시점 클립을 아는 pdf-ops 만 정할 수 있다.
 */
export function pathCoreWarnings(
  plan: Pick<PathEditPlan, 'fill' | 'stroke' | 'target'>,
  edit: PathEdit,
  layout: PageLayout,
): EditWarning[] {
  const warnings: EditWarning[] = [];
  if (edit.delete) {
    const [x0, y0, x1, y1] = plan.target.bbox;
    const thin = Math.min(x1 - x0, y1 - y0) <= RULE_MAX_THICKNESS_PT;
    const rects = layout.tables
      .filter(
        (t) => t.strategy === 'lines' && intersectRect(inflateRect(t.bbox, 2), plan.target.bbox),
      )
      .map((t) => t.bbox);
    if (thin && rects.length > 0) {
      warnings.push({
        kind: 'table-rule-removed',
        message: '표 괘선으로 쓰인 패스를 지웠습니다. 표 인식이 바뀔 수 있습니다.',
        rects: [plan.target.bbox],
      });
    }
    return warnings;
  }
  if (needsSpaceChange(plan.fill, edit.fill) || needsSpaceChange(plan.stroke, edit.stroke)) {
    warnings.push({
      kind: 'color-space-changed',
      message: '새 색을 쓰려고 색공간을 DeviceRGB 로 바꿨습니다.',
      rects: [plan.target.bbox],
    });
  }
  return warnings;
}

/**
 * 저장 파일에서 폴백 폰트 서브셋의 이름에 서브셋 태그(`ABCDEF+`)를 붙인다(PDF 32000 9.6.4, R-L2). 태그는 서브셋 글꼴
 * 바이트의 해시에서 정해 같은 글자 집합이면 같다(결정성). 저장 작업 안에서 서브셋 교체 뒤에 부르고, 작업을 버리면 되돌아간다.
 * 서브셋 바이트가 없으면(교체 실패·건너뜀) 아무것도 하지 않는다.
 */
export function tagFallbackSubset(doc: mupdf.PDFDocument, fontRef: mupdf.PDFObject): void {
  const font = fontRef.resolve();
  if (!font.isDictionary()) return;
  const descendant = font.get('DescendantFonts').get(0);
  const descriptor = descendant.get('FontDescriptor');
  const file = descriptor.get('FontFile2');
  if (!file.isStream()) return;
  const buffer = file.readStream();
  let hash = 0x811c9dc5;
  try {
    for (const byte of buffer.asUint8Array()) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  } finally {
    buffer.destroy();
  }
  let tag = '';
  for (let i = 0; i < 6; i++) {
    tag += String.fromCharCode(65 + (hash % 26));
    hash = (Math.floor(hash / 26) + Math.imul(i + 1, 0x9e3779b1)) >>> 0;
  }
  const current = font.get('BaseFont');
  const base = current.isName() ? current.asName() : 'NotoSansKR';
  if (/^[A-Z]{6}\+/.test(base)) return;
  const tagged = doc.newName(`${tag}+${base}`);
  font.put('BaseFont', tagged);
  descendant.put('BaseFont', doc.newName(`${tag}+${base}`));
  descriptor.put('FontName', doc.newName(`${tag}+${base}`));
}
