/**
 * `runPageContents`(항등 행렬)의 Device 콜백을 모아 글리프·도형·이미지·셰이드를 센다.
 * 순서 번호 규칙은 docs/m1-contract.md 3절·3.1(첫 등장 계수):
 * - glyphSeq: 표시 글리프마다 1, 처음 Device 에 도착한 텍스트 콜백에서 센다. 같은 텍스트 객체(포인터
 *   동일)를 연속으로 받은 fill↔stroke(Tr 2·6)와, MuPDF 가 BT 안 Tr 4–7 글리프를 ET 에서 다시 보내는
 *   clipText·ignoreText(ET 재전송)는 세지 않는다.
 * - paintSeq: 텍스트 외 그리기 콜백마다 1.
 * - 소프트 마스크 그룹(beginMask…endMask) 안의 콜백은 glyphSeq·paintSeq 모두 세지 않는다.
 *   타일링 패턴의 셀 내용은 `beginTile` 이 0 이 아닌 값을 돌려주어 MuPDF 가 실행하지 않게 한다.
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

/** Device 가 준 글리프 하나(구조화 텍스트와 결합하기 전). */
export interface RawGlyph {
  gid: number;
  unicode: number;
  /**
   * 같은 글리프에 딸린 추가 유니코드. ToUnicode 가 글리프 하나를 여러 글자("Th", "fi", 점선 …)로
   * 대응시키면 MuPDF 는 글리프를 gid 로 한 번 보내고, 나머지 글자를 gid -1(폭 0) 항목으로 잇는다.
   * 그 항목은 글리프가 아니므로 세지 않고 여기에 모은다.
   */
  extra: number[];
  fontId: number;
  /** 글리프 공간(em, y 위) → 페이지 공간. e·f 가 기준선 원점. */
  m: Matrix;
  /** 페이지 공간 글자 크기(pt). */
  size: number;
  wmode: 0 | 1;
  render: TextRender;
  /** 클립 텍스트 표기(계약 3.1 표기 표). */
  clip: boolean;
  /** 이 글리프를 그린 색. 색을 알 수 없으면(invisible·패턴 색) null. */
  rgb: RGB | null;
  /** 색을 알 수 없는 글리프(클립·ignoreText 에서 처음 센 글리프). 구조화 텍스트 색도 쓰지 않는다. */
  noColor: boolean;
  /** 폰트 advance(em). quad 근사에 쓴다. */
  advance: number;
}

interface PrevText {
  ptr: unknown;
  text: mupdf.Text;
  kind: 'fill' | 'stroke' | 'fill-stroke' | 'invisible' | 'clip';
  first: number;
  end: number;
}

/** 클립 스택 항목. `textGlyphs` 는 이 클립 콜백이 처음 센 글리프 범위(패턴 색 텍스트 판정용). */
interface ClipEntry {
  bbox: Rect;
  textGlyphs: [number, number] | null;
}

const unitRect: Rect = [0, 0, 1, 1];

/**
 * 재전송 판정 키(계약 3.1 단계 2): 폰트 동일성, gid, 글리프 trm 6값, 콜백 ctm 6값. 숫자 문자열은 비트 단위로 같은
 * 값에서만 같다. ctm 을 넣는 이유: 같은 Form 을 다른 위치에 그리면 trm 은 같고 ctm 만 다르다. BT 안에서는
 * cm 을 쓸 수 없으므로 ET 재전송의 ctm 은 표시 시점 ctm 과 같다.
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
  /** ET 재전송으로 소비해 세지 않은 글리프 수. */
  retransmitted = 0;
  /** clipText·clipStrokeText 가 처음 센 글리프 수(Tr 7, 패턴 색 텍스트, 꺼진 /OC 의 재전송 …). */
  clipCounted = 0;
  /** 콜백 안에서 난 첫 예외. WASM 프레임을 거쳐 던지지 않도록 모아 두었다가 실행 뒤에 던진다. */
  error: unknown = null;

  #fontIds = new Map<unknown, number>();
  #clipStack: ClipEntry[];
  #prev: PrevText | null = null;
  /** "센 목록": fill/stroke(와 클립)에서 센 글리프 키 → 아직 소비되지 않은 글리프 인덱스(앞에서부터). */
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
   * 콜백 본문을 실행한다. 이미 실패했거나 소프트 마스크 그룹 안이면 건너뛴다
   * (`structural` 은 마스크 경계 콜백용으로 마스크 안에서도 실행).
   * 본문을 실행했으면(예외 포함) true. 건너뛰었으면 false 이고, 본문이 넘겨받을 래퍼(Text)는 호출자가 놓는다.
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

  /** 실행이 끝났을 때(성공·실패 모두) 잡고 있는 래퍼를 놓는다. */
  finish(): void {
    this.#releasePrev();
  }

  // --- 텍스트 -------------------------------------------------------------------------

  fillText(text: mupdf.Text, ctm: Matrix, cs: mupdf.ColorSpace, color: number[]): void {
    this.#text('fill', text, ctm, cs, color);
  }

  strokeText(text: mupdf.Text, ctm: Matrix, cs: mupdf.ColorSpace, color: number[]): void {
    this.#text('stroke', text, ctm, cs, color);
  }

  /** ignoreText: 처음 도착한 글리프만 센다(Tr 3). Tr 4–7 의 ET 재전송이면 소비한다. */
  ignoreText(text: mupdf.Text, ctm: Matrix): void {
    this.#text('invisible', text, ctm, null, null);
  }

  /** clipText·clipStrokeText: 센 목록과 같은 글리프는 ET 재전송으로 소비하고, 아니면 새로 센다. */
  clipText(text: mupdf.Text, ctm: Matrix): void {
    this.#text('clip', text, ctm, null, null);
  }

  /**
   * 모든 텍스트 콜백의 진입부(계약 3.1 단계 1).
   * 직전 텍스트 콜백과 텍스트 객체 포인터가 같으면 종류와 무관하게 통째로 건너뛴다(같은 실행 단위의
   * fill→stroke, 패턴 색 clip→clipStroke, fill→clipStroke). 사이에 비텍스트 콜백(패턴 칠하기, popClip)이
   * 끼어도 같다. 직전 래퍼는 다음 텍스트 콜백의 비교가 끝날 때까지 잡고 있으므로 같은 포인터는 같은
   * 객체다(즉시 destroy 하면 해제된 주소가 재사용된다). ET 재전송은 항상 새 텍스트 객체다.
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
      // 건너뛴 콜백이 클립이면 popClip 짝을 맞추려고 클립 스택에는 올린다(글리프는 이미 처음 콜백이 셌다).
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

  /** fillText·strokeText 의 새 텍스트 객체 (계약 3.1 단계 2). */
  #showPainted(kind: 'fill' | 'stroke', text: mupdf.Text, ctm: Matrix, rgb: RGB | null): void {
    const first = this.glyphs.length;
    text.walk({
      showGlyph: (font, trm, gid, unicode, wmode) => {
        if (gid < 0) return this.#appendExtra(first, unicode);
        // 단계 2: 번호를 주고 센 목록에 넣는다.
        const index = this.#push(font, trm, gid, unicode, wmode, kind, false, rgb, ctm);
        this.#remember(index, trm, ctm);
      },
    });
  }

  /**
   * clipText·clipStrokeText·ignoreText (계약 3.1 단계 3·4).
   * 센 목록에 미소비 항목이 있으면 소비하고 세지 않는다(Tr 4–6 이면 그 글리프에 clip 표시). 아니면 새로 센다.
   */
  #showUnpainted(text: mupdf.Text, ctm: Matrix, isClip: boolean): void {
    const first = this.glyphs.length;
    let consumed = 0;
    // 직전 글리프(새로 센 것이든 소비한 것이든)의 인덱스와, 그 글리프에 붙은 보조 글리프 수.
    let target: number | null = null;
    let auxSeen = 0;
    text.walk({
      showGlyph: (font, trm, gid, unicode, wmode) => {
        if (gid < 0) {
          // 계약 3.1 단계 0: 직전 글리프의 CharInfo 에 유니코드를 붙인다. 소비한 재전송 글리프는 fill/stroke 에서
          // 이미 받았으면 다시 붙이지 않는다(재전송에는 보통 보조 글리프가 없다).
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
        // 처음 센 글리프. 클립 콜백이면 Tr 7 처럼 보이는 글리프로 표기하고(패턴 색 텍스트는 뒤에 고친다),
        // ignoreText 면 Tr 3 으로 표기한다.
        const index = this.#push(font, trm, gid, unicode, wmode, 'invisible', isClip, null, ctm);
        target = index;
        if (isClip) {
          this.clipCounted++;
          this.#remember(index, trm, ctm);
        }
      },
    });
    // 단계 4: 소비가 있었으면 센 목록을 비운다.
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

  /** gid -1 항목: 같은 텍스트 객체의 앞 글리프에 유니코드를 붙인다. 글리프가 아니므로 세지 않는다. */
  #appendExtra(first: number, unicode: number): void {
    if (this.glyphs.length > first) this.glyphs[this.glyphs.length - 1]!.extra.push(unicode);
  }

  /** 센 목록에 글리프를 넣는다. 같은 키가 여러 번 들어오면 각각 별도 항목이다. */
  #remember(index: number, trm: Matrix, ctm: Matrix): void {
    const g = this.glyphs[index]!;
    const key = glyphKey(g.fontId, g.gid, trm, ctm);
    const list = this.#counted.get(key);
    if (list) list.push(index);
    else this.#counted.set(key, [index]);
  }

  /** 센 목록에서 키가 같은 미소비 항목 하나(가장 앞)를 소비해 글리프 인덱스를 돌려준다. */
  #consume(key: string): number | undefined {
    const list = this.#counted.get(key);
    if (!list) return undefined;
    const index = list.shift();
    if (list.length === 0) this.#counted.delete(key);
    return index;
  }

  #fontId(font: mupdf.Font): number {
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

  /** 직전 텍스트 래퍼를 놓는다. 래퍼를 놓으면 C 객체가 해제되어 주소가 재사용되므로 비교가 끝난 뒤에만 부른다. */
  #releasePrev(): void {
    if (this.#prev) {
      this.#prev.text.destroy();
      this.#prev = null;
    }
  }

  /**
   * 같은 클립의 popClip 전에 fillShade·beginTile 이 오면 그 클립이 처음 센 글리프는 패턴 색 텍스트다
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

  // --- 도형 ---------------------------------------------------------------------------

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
    // 선이 있으면 선 폭을 포함한 경계, 없으면 경로 점(곡선은 제어점 포함)의 경계.
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

  // --- 이미지·셰이드 -------------------------------------------------------------------

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
    // `sh` 의 셰이드는 경계가 무한(±2^31 근처)일 수 있다. 그때는 현재 클립 경계를 쓴다.
    const unbounded = bounds.some((v) => !Number.isFinite(v) || Math.abs(v) >= 2 ** 30);
    const bbox = intersectRect(unbounded ? this.top() : transformRect(bounds, ctm), this.top());
    this.shades.push({ paintSeq: this.paintSeq++, bbox, alpha });
  }

  // --- 클립 스택 ----------------------------------------------------------------------

  /** 실행이 끝났을 때 클립 스택에 남은 항목 수(균형이 맞으면 0). */
  get clipDepth(): number {
    return this.#clipStack.length - 1;
  }

  /** 현재 클립 경계(페이지 공간). 셰이드 경계를 접는 데 쓴다. */
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

  /** `endMask` 는 마스크를 클립으로 올린다(이후 popClip 으로 내려간다). */
  endMask(): void {
    if (this.#maskDepth > 0) this.#maskDepth--;
    if (this.#maskDepth === 0) this.pushClip(this.top());
  }
}

interface WalkedPath {
  bbox: Rect;
  segments: PathSegment[] | null;
}

/** 경로를 한 번 돌며 페이지 공간 경계(제어점 포함)와, 요청 시 경로 공간 세그먼트를 모은다. */
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
