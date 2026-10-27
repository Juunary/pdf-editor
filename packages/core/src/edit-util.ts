/** Pure helper functions used by the edit session (geometry, warnings, fallback font bytes, PDF/A declaration check). */
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

/** null if they do not overlap. */
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

/** Warnings decided by FontManager. They are recomputed each time from the current text, so they replace the planning-stage warnings. */
const FONT_WARNING_KINDS: ReadonlySet<EditWarningKind> = new Set<EditWarningKind>([
  'font-fallback',
  'glyph-missing',
  'synthetic-style',
]);

/** Warnings that core decides directly from the reflow result. */
const CORE_WARNING_KINDS: ReadonlySet<EditWarningKind> = new Set<EditWarningKind>([
  'overflow-clipped',
  'area-overlaps-content',
]);

/** Part beyond the area limit is clipped in rendering (contract 5.4: overflow when automatic expansion is blocked by the limit). */
const CLIP_TOLERANCE_PT = 0.5;
/** Minimum side length (pt) to count as an overlap. Touching borders are not counted as overlapping. */
const OVERLAP_MIN_PT = 0.5;

/** Parts of `contentBox` that fall outside `areaLimit` (top, bottom, left and right bands). */
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
  /** Paragraph being edited (layout id). Excluded from the overlap check against other content. */
  paragraphId: number;
  /** Original paragraph bbox. Tables and shapes (backgrounds) covering this box are not counted as overlaps. */
  originalBox: Rect;
}

/**
 * Warnings decided from the reflow result (contract 5.1, 5.4): `overflow-clipped` (layout box outside the area limit),
 * `area-overlaps-content` (the written area overlaps another paragraph, table or shape; tables and shapes covering the original paragraph bbox are excluded).
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
    // A box the original paragraph already overlapped (tight line spacing, text over a picture) is not an overlap created by enlarging the area.
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
 * Draft warning list. Among planning-stage warnings, the font and core-classified kinds are replaced with fresh results based on the current text
 * (deleting the text removes `glyph-missing`). Warnings of the same kind are merged into one.
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

/** Whether /Metadata (XMP) has a PDF/A declaration (`pdfaid:part`) (contract 5.6). false if it cannot be read. */
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
 * If trailer /Info is not a resolvable dictionary, creates a new empty dictionary. Call only outside an operation (journal) (contract D9, docs/m3-core.md 2.2).
 * Adding an object makes MuPDF create a new xref section, and the trailer becomes a new dictionary too, so create the object first and call `getTrailer()`
 * afterwards (putting it into a trailer obtained earlier does not reflect in the current trailer, docs/m3-core.md 2.2).
 */
export function ensureInfoDictionary(doc: mupdf.PDFDocument): void {
  // isDictionary follows indirect references. false for a broken reference or null.
  const info = doc.getTrailer().get('Info');
  if (info.isDictionary()) {
    // For a direct dictionary, trailer changes are not recorded in the journal and undo cannot reach them. Convert it to an indirect object.
    if (!info.isIndirect()) {
      const ref = doc.addObject(info);
      doc.getTrailer().put('Info', ref);
    }
    return;
  }
  const created = doc.addObject(doc.newDictionary());
  doc.getTrailer().put('Info', created);
}

/** Upper bound (pt) on the short side of a thin path that can be taken as a table rule. */
const RULE_MAX_THICKNESS_PT = 3;
/** 8-bit rounding tolerance for treating color channels as "equal". */
const RGB_EPSILON = 0.5 / 255;

function sameRgb(a: RGB, b: RGB): boolean {
  return a.every((v, i) => Math.abs(v - b[i]!) <= RGB_EPSILON);
}

/**
 * Whether the new color cannot be written in the original color space family and must be changed to DeviceRGB (contract D3). Device families with 1, 3 or 4 components are kept as is,
 * but a Gray with saturation cannot; Separation, DeviceN, Indexed and Lab always cannot. The same color as the original rgb approximation is a channel
 * that is not written, so it does not apply. This approximates pdf-ops' actual write decision; if pdf-ops reports a warning of the same kind, they are merged.
 */
function needsSpaceChange(old: PaintColor | null, next: RGB | null): boolean {
  if (!old || !next) return false;
  if (old.rgb && sameRgb(old.rgb, next)) return false;
  if (/Separation|DeviceN|Indexed|Lab/i.test(old.space)) return true;
  if (old.values.length === 1) return Math.max(...next) - Math.min(...next) > RGB_EPSILON;
  return false;
}

/**
 * Warnings core decides for a path edit request (contract 4.2): `color-space-changed` (D3 approximation), `table-rule-removed` (D2: erased a thin path
 * inside a table rule, layout-based approximation). `path-clipped` can be decided only by pdf-ops, which knows the clip at paint time.
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
 * In the saved file, attaches a subset tag (`ABCDEF+`) to the name of the fallback font subset (PDF 32000 9.6.4, R-L2). The tag is derived from a hash of the subset font
 * bytes, so the same character set gives the same tag (determinism). Call it within the save operation after the subset swap; discarding the operation reverts it.
 * If there are no subset bytes (swap failed or skipped), does nothing.
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
