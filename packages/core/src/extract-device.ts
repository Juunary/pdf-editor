/**
 * Collects the Device callbacks of `runPageContents` (identity matrix) and counts glyphs, shapes, images and shades.
 * Sequence-number rules follow docs/m1-contract.md section 3 and 3.1 (first-appearance counting):
 * - glyphSeq: 1 per displayed glyph, counted at the text callback that first reaches the Device. Not counted: fill<->stroke (Tr 2, 6) receiving the same text object (same pointer)
 *   consecutively, and clipText and ignoreText (ET re-sends), where MuPDF sends the Tr 4–7 glyphs
 *   inside BT again at ET.
 * - paintSeq: 1 per non-text drawing callback.
 * - Callbacks inside a soft-mask group (beginMask…endMask) count toward neither glyphSeq nor paintSeq.
 *   For the cell content of a tiling pattern, `beginTile` returns a non-zero value so that MuPDF does not execute it.
 */
import * as mupdf from 'mupdf';
import type {
  FontInfo,
  ImageInfo,
  Matrix,
  PathInfo,
  PathSegment,
  Point,
  RGB,
  Rect,
  ShadeInfo,
  TextRender,
} from '@pdf-editor/shared-types';
import type { ColorConverter } from './color.js';
import { intersectRect, transformPoint, transformRect } from './page-geometry.js';

/** One glyph given by the Device (before joining with structured text). */
export interface RawGlyph {
  gid: number;
  unicode: number;
  /**
   * Additional Unicode attached to the same glyph. When ToUnicode maps one glyph to several characters ("Th", "fi", dotted leader ...),
   * MuPDF sends the glyph once by gid and chains the remaining characters as gid -1 (width 0) entries.
   * Those entries are not glyphs, so they are not counted and are collected here.
   */
  extra: number[];
  fontId: number;
  /** Glyph space (em, y up) -> page space. e and f are the baseline origin. */
  m: Matrix;
  /** Font size in page space (pt). */
  size: number;
  wmode: 0 | 1;
  render: TextRender;
  /** Clip-text notation (contract 3.1 notation table). */
  clip: boolean;
  /** Color this glyph was drawn with. null if the color is unknown (invisible or pattern color). */
  rgb: RGB | null;
  /** Glyph whose color is unknown (first counted in clip or ignoreText). The structured-text color is not used either. */
  noColor: boolean;
  /** Font advance (em). Used for quad approximation. */
  advance: number;
}

interface PrevText {
  ptr: unknown;
  text: mupdf.Text;
  kind: 'fill' | 'stroke' | 'fill-stroke' | 'invisible' | 'clip';
  first: number;
  end: number;
}

/** Clip stack entry. `textGlyphs` is the range of glyphs this clip callback first counted (for classifying pattern-color text). */
interface ClipEntry {
  bbox: Rect;
  textGlyphs: [number, number] | null;
}

const unitRect: Rect = [0, 0, 1, 1];

/**
 * Re-send classification key (contract 3.1 step 2): font identity, gid, 6 glyph trm values, 6 callback ctm values. Numeric strings are equal only for values that are bit-for-bit
 * identical. Why ctm is included: drawing the same Form at a different position gives the same trm and only a different ctm. Inside BT,
 * cm cannot be used, so the ctm of an ET re-send equals the ctm at display time.
 */
function glyphKey(fontId: number, gid: number, trm: Matrix, ctm: Matrix): string {
  return `${fontId}|${gid}|${trm.join(',')}|${ctm.join(',')}`;
}

export class DeviceCollector {
  readonly glyphs: RawGlyph[] = [];
  readonly fonts: FontInfo[] = [];
  readonly paths: PathInfo[] = [];
  readonly images: ImageInfo[] = [];
  readonly shades: ShadeInfo[] = [];
  paintSeq = 0;
  /** Number of glyphs consumed by ET re-sends and not counted. */
  retransmitted = 0;
  /** Number of glyphs first counted by clipText and clipStrokeText (Tr 7, pattern-color text, re-sends of a disabled /OC, ...). */
  clipCounted = 0;
  /** First exception raised inside a callback. Collected and thrown after the run so that it is not thrown through WASM frames. */
  error: unknown = null;

  #fontIds = new Map<unknown, number>();
  #clipStack: ClipEntry[];
  #prev: PrevText | null = null;
  /** "Counted list": glyph key counted in fill/stroke (and clip) -> indices of glyphs not yet consumed (from the front). */
  #counted = new Map<string, number[]>();
  #maskDepth = 0;

  constructor(
    pageBounds: Rect,
    private readonly colors: ColorConverter,
    private readonly includeSegments: boolean,
  ) {
    this.#clipStack = [{ bbox: pageBounds, textGlyphs: null }];
  }

  /**
   * Runs the callback body. Skipped if a failure already occurred or if inside a soft-mask group
   * (`structural` runs even inside a mask, for the mask boundary callbacks).
   * true if the body ran (including by throwing). false if skipped, in which case the caller releases the wrapper (Text) the body would have taken over.
   */
  guard(body: () => void, structural = false): boolean {
    if (this.error !== null) return false;
    if (this.#maskDepth > 0 && !structural) return false;
    try {
      body();
    } catch (e) {
      this.error = e;
    }
    return true;
  }

  /** Releases the wrappers still held when the run ends (both success and failure). */
  finish(): void {
    this.#releasePrev();
    // mupdf.js creates a new Font wrapper (reference 1) each time the font changes and leaves release to the GC. To keep a large font (fallback, about 4 MB) from lingering until GC,
    // release the received wrappers at the end of extraction (R-L3). The last wrapper is pointed to by a mupdf.js global, but when its pointer becomes 0 the next
    // text creates a new one.
    for (const font of this.#fontWrappers) font.destroy();
    this.#fontWrappers.clear();
  }

  readonly #fontWrappers = new Set<mupdf.Font>();

  // --- Text -------------------------------------------------------------------------

  fillText(text: mupdf.Text, ctm: Matrix, cs: mupdf.ColorSpace, color: number[]): void {
    this.#text('fill', text, ctm, cs, color);
  }

  strokeText(text: mupdf.Text, ctm: Matrix, cs: mupdf.ColorSpace, color: number[]): void {
    this.#text('stroke', text, ctm, cs, color);
  }

  /** ignoreText: counts only a glyph arriving for the first time (Tr 3). Consumes it if it is an ET re-send of Tr 4–7. */
  ignoreText(text: mupdf.Text, ctm: Matrix): void {
    this.#text('invisible', text, ctm, null, null);
  }

  /** clipText and clipStrokeText: a glyph equal to one in the counted list is consumed as an ET re-send; otherwise it is counted as new. */
  clipText(text: mupdf.Text, ctm: Matrix): void {
    this.#text('clip', text, ctm, null, null);
  }

  /**
   * Entry of every text callback (contract 3.1 step 1).
   * If the text object pointer equals the previous text callback's, skip it entirely regardless of kind (fill->stroke,
   * pattern-color clip->clipStroke, fill->clipStroke of the same run unit). The same holds even when a non-text callback (pattern fill, popClip)
   * comes in between. The previous wrapper is held until the next text callback's comparison finishes, so the same pointer means the same
   * object (destroying it immediately would reuse the freed address). An ET re-send is always a new text object.
   */
  #text(
    kind: PrevText['kind'],
    text: mupdf.Text,
    ctm: Matrix,
    cs: mupdf.ColorSpace | null,
    color: number[] | null,
  ): void {
    const prev = this.#prev;
    if (prev && prev.ptr === text.pointer) {
      text.destroy();
      if (
        cs &&
        color &&
        ((prev.kind === 'fill' && kind === 'stroke') || (prev.kind === 'stroke' && kind === 'fill'))
      ) {
        const fillRgb = kind === 'fill' ? this.colors.paint(cs, color).rgb : null;
        for (let i = prev.first; i < prev.end; i++) {
          const g = this.glyphs[i]!;
          g.render = 'fill-stroke';
          if (kind === 'fill') g.rgb = fillRgb;
        }
        prev.kind = 'fill-stroke';
      }
      // If the skipped callback is a clip, push it on the clip stack to keep the popClip pairing (the first callback already counted the glyph).
      if (kind === 'clip') this.#clipStack.push({ bbox: this.top(), textGlyphs: null });
      return;
    }
    this.#releasePrev();
    const first = this.glyphs.length;
    const entry: PrevText = { ptr: text.pointer, text, kind, first, end: first };
    this.#prev = entry;
    if (kind === 'fill' || kind === 'stroke') {
      this.#showPainted(kind, text, ctm, this.colors.paint(cs!, color!).rgb);
    } else {
      this.#showUnpainted(text, ctm, kind === 'clip');
    }
    entry.end = this.glyphs.length;
  }

  /** New text object of fillText and strokeText (contract 3.1 step 2). */
  #showPainted(kind: 'fill' | 'stroke', text: mupdf.Text, ctm: Matrix, rgb: RGB | null): void {
    const first = this.glyphs.length;
    text.walk({
      showGlyph: (font, trm, gid, unicode, wmode) => {
        if (gid < 0) return this.#appendExtra(first, unicode);
        // Step 2: assign a number and put it into the counted list.
        const index = this.#push(font, trm, gid, unicode, wmode, kind, false, rgb, ctm);
        this.#remember(index, trm, ctm);
      },
    });
  }

  /**
   * clipText, clipStrokeText and ignoreText (contract 3.1 steps 3 and 4).
   * If the counted list has an unconsumed entry, consume it and do not count (for Tr 4–6, mark that glyph as clip). Otherwise count it as new.
   */
  #showUnpainted(text: mupdf.Text, ctm: Matrix, isClip: boolean): void {
    const first = this.glyphs.length;
    let consumed = 0;
    // Index of the previous glyph (newly counted or consumed) and the number of auxiliary glyphs attached to it.
    let target: number | null = null;
    let auxSeen = 0;
    text.walk({
      showGlyph: (font, trm, gid, unicode, wmode) => {
        if (gid < 0) {
          // Contract 3.1 step 0: attach Unicode to the previous glyph's CharInfo. A consumed re-send glyph is not attached again
          // if it was already received in fill/stroke (re-sends usually have no auxiliary glyphs).
          if (target !== null) {
            const g = this.glyphs[target]!;
            if (auxSeen >= g.extra.length) g.extra.push(unicode);
            auxSeen++;
          }
          return;
        }
        auxSeen = 0;
        const hit = this.#consume(glyphKey(this.#fontId(font), gid, trm, ctm));
        if (hit !== undefined) {
          consumed++;
          this.retransmitted++;
          this.glyphs[hit]!.clip = true;
          target = hit;
          return;
        }
        // First-counted glyph. For a clip callback, mark it as a glyph that looks like Tr 7 (pattern-color text is fixed up later),
        // for ignoreText mark it as Tr 3.
        const index = this.#push(font, trm, gid, unicode, wmode, 'invisible', isClip, null, ctm);
        target = index;
        if (isClip) {
          this.clipCounted++;
          this.#remember(index, trm, ctm);
        }
      },
    });
    // Step 4: if anything was consumed, clear the counted list.
    if (consumed > 0) this.#counted.clear();
    if (isClip) {
      const end = this.glyphs.length;
      this.#clipStack.push({ bbox: this.top(), textGlyphs: end > first ? [first, end] : null });
    }
  }

  #push(
    font: mupdf.Font,
    trm: Matrix,
    gid: number,
    unicode: number,
    wmode: number,
    render: TextRender,
    clip: boolean,
    rgb: RGB | null,
    ctm: Matrix,
  ): number {
    const m = mupdf.Matrix.concat(trm, ctm) as Matrix;
    return (
      this.glyphs.push({
        gid,
        unicode,
        extra: [],
        fontId: this.#fontId(font),
        m,
        size: Math.hypot(m[2], m[3]),
        wmode: wmode === 1 ? 1 : 0,
        render,
        clip,
        rgb,
        noColor: rgb === null,
        advance: font.advanceGlyph(gid, wmode),
      }) - 1
    );
  }

  /** gid -1 entry: attaches Unicode to the preceding glyph of the same text object. Not a glyph, so it is not counted. */
  #appendExtra(first: number, unicode: number): void {
    if (this.glyphs.length > first) this.glyphs[this.glyphs.length - 1]!.extra.push(unicode);
  }

  /** Puts a glyph into the counted list. If the same key arrives several times, each is a separate entry. */
  #remember(index: number, trm: Matrix, ctm: Matrix): void {
    const g = this.glyphs[index]!;
    const key = glyphKey(g.fontId, g.gid, trm, ctm);
    const list = this.#counted.get(key);
    if (list) list.push(index);
    else this.#counted.set(key, [index]);
  }

  /** Consumes one unconsumed entry with the same key from the counted list (the earliest) and returns the glyph index. */
  #consume(key: string): number | undefined {
    const list = this.#counted.get(key);
    if (!list) return undefined;
    const index = list.shift();
    if (list.length === 0) this.#counted.delete(key);
    return index;
  }

  #fontId(font: mupdf.Font): number {
    this.#fontWrappers.add(font);
    const known = this.#fontIds.get(font.pointer);
    if (known !== undefined) return known;
    const id = this.fonts.length;
    this.fonts.push({
      id,
      name: font.getName(),
      bold: font.isBold(),
      italic: font.isItalic(),
      serif: font.isSerif(),
      mono: font.isMono(),
    });
    this.#fontIds.set(font.pointer, id);
    return id;
  }

  /** Releases the previous text wrapper. Releasing it frees the C object and the address is reused, so call it only after the comparison is finished. */
  #releasePrev(): void {
    if (this.#prev) {
      this.#prev.text.destroy();
      this.#prev = null;
    }
  }

  /**
   * If fillShade or beginTile comes before the popClip of the same clip, the glyphs that clip first counted are pattern-color text
   * (render fill, clip false, color null).
   */
  #patternPaint(): void {
    const top = this.#clipStack[this.#clipStack.length - 1]!;
    if (!top.textGlyphs) return;
    for (let i = top.textGlyphs[0]; i < top.textGlyphs[1]; i++) {
      const g = this.glyphs[i]!;
      g.render = 'fill';
      g.clip = false;
    }
    top.textGlyphs = null;
  }

  beginTile(): void {
    this.#patternPaint();
  }

  // --- Shapes ---------------------------------------------------------------------------

  fillPath(
    path: mupdf.Path,
    evenOdd: boolean,
    ctm: Matrix,
    cs: mupdf.ColorSpace,
    color: number[],
    alpha: number,
  ): void {
    this.#path('fill', path, null, evenOdd, ctm, this.colors.paint(cs, color), alpha);
  }

  strokePath(
    path: mupdf.Path,
    stroke: mupdf.StrokeState,
    ctm: Matrix,
    cs: mupdf.ColorSpace,
    color: number[],
    alpha: number,
  ): void {
    this.#path('stroke', path, stroke, false, ctm, this.colors.paint(cs, color), alpha);
  }

  clipPath(path: mupdf.Path, evenOdd: boolean, ctm: Matrix): void {
    this.#path('clip', path, null, evenOdd, ctm, null, 1);
  }

  clipStrokePath(path: mupdf.Path, stroke: mupdf.StrokeState, ctm: Matrix): void {
    this.#path('clip-stroke', path, stroke, false, ctm, null, 1);
  }

  #path(
    op: PathInfo['op'],
    path: mupdf.Path,
    stroke: mupdf.StrokeState | null,
    evenOdd: boolean,
    ctm: Matrix,
    color: PathInfo['color'],
    alpha: number,
  ): void {
    const paintSeq = this.paintSeq++;
    const walked = walkPath(path, ctm, this.includeSegments);
    // With a stroke, the bounds including the line width; without one, the bounds of the path points (including control points for curves).
    const bbox = stroke ? (path.getBounds(stroke, ctm) as Rect) : walked.bbox;
    this.paths.push({
      paintSeq,
      op,
      evenOdd,
      bbox,
      ctm,
      color,
      alpha,
      lineWidth: stroke ? stroke.getLineWidth() : null,
      segments: walked.segments,
    });
    if (op === 'clip' || op === 'clip-stroke') this.pushClip(intersectRect(bbox, this.top()));
  }

  // --- Images and shades -------------------------------------------------------------------

  fillImage(image: mupdf.Image, ctm: Matrix, alpha: number): void {
    this.#image('image', image, ctm, alpha);
  }

  fillImageMask(image: mupdf.Image, ctm: Matrix, alpha: number): void {
    this.#image('image-mask', image, ctm, alpha);
  }

  clipImageMask(image: mupdf.Image, ctm: Matrix): void {
    const bbox = this.#image('clip-image-mask', image, ctm, 1);
    this.pushClip(intersectRect(bbox, this.top()));
  }

  #image(op: ImageInfo['op'], image: mupdf.Image, ctm: Matrix, alpha: number): Rect {
    const bbox = transformRect(unitRect, ctm);
    this.images.push({
      paintSeq: this.paintSeq++,
      op,
      bbox,
      ctm,
      width: image.getWidth(),
      height: image.getHeight(),
      alpha,
    });
    return bbox;
  }

  fillShade(shade: mupdf.Shade, ctm: Matrix, alpha: number): void {
    this.#patternPaint();
    const bounds = shade.getBounds() as Rect;
    // The shade of `sh` may have infinite bounds (near ±2^31). In that case use the current clip bounds.
    const unbounded = bounds.some((v) => !Number.isFinite(v) || Math.abs(v) >= 2 ** 30);
    const bbox = intersectRect(unbounded ? this.top() : transformRect(bounds, ctm), this.top());
    this.shades.push({ paintSeq: this.paintSeq++, bbox, alpha });
  }

  // --- Clip stack ----------------------------------------------------------------------

  /** Number of entries left on the clip stack when the run ended (0 if balanced). */
  get clipDepth(): number {
    return this.#clipStack.length - 1;
  }

  /** Current clip bounds (page space). Used to fold the shade bounds. */
  top(): Rect {
    return this.#clipStack[this.#clipStack.length - 1]!.bbox;
  }

  pushClip(bbox: Rect): void {
    this.#clipStack.push({ bbox, textGlyphs: null });
  }

  popClip(): void {
    if (this.#clipStack.length > 1) this.#clipStack.pop();
  }

  beginMask(): void {
    this.#maskDepth++;
  }

  /** `endMask` pushes the mask as a clip (later popped with popClip). */
  endMask(): void {
    if (this.#maskDepth > 0) this.#maskDepth--;
    if (this.#maskDepth === 0) this.pushClip(this.top());
  }
}

interface WalkedPath {
  bbox: Rect;
  segments: PathSegment[] | null;
}

/** Walks the path once and collects page-space bounds (including control points) and, on request, path-space segments. */
function walkPath(path: mupdf.Path, ctm: Matrix, wantSegments: boolean): WalkedPath {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const segments: PathSegment[] | null = wantSegments ? [] : null;
  const include = (x: number, y: number): void => {
    const p = transformPoint(ctm, x, y);
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  };
  path.walk({
    moveTo(x, y) {
      include(x, y);
      segments?.push({ type: 'M', p: [x, y] satisfies Point });
    },
    lineTo(x, y) {
      include(x, y);
      segments?.push({ type: 'L', p: [x, y] });
    },
    curveTo(ax, ay, bx, by, cx, cy) {
      include(ax, ay);
      include(bx, by);
      include(cx, cy);
      segments?.push({ type: 'C', p1: [ax, ay], p2: [bx, by], p3: [cx, cy] });
    },
    closePath() {
      segments?.push({ type: 'Z' });
    },
  });
  const empty = x0 === Infinity;
  return { bbox: empty ? [0, 0, 0, 0] : [x0, y0, x1, y1], segments };
}
