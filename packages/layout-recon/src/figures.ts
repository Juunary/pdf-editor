/**
 * 도형 검출(계약 3절 4단계): 큰 이미지와 벡터 경로 군집. 표 괘선·배경, 글을 담은 배경 상자는 뺀다.
 */
import type { PageModel, Rect } from '@pdf-editor/shared-types';
import { C } from './constants.js';
import { CAPTION } from './text-rules.js';
import type { LineFeature } from './features.js';
import { area, center, containsPoint, expand, intersect, union, width } from './geom.js';
import type { PathSummary } from './paths.js';

export interface DetectedFigure {
  bbox: Rect;
  kind: 'image' | 'vector';
  images: number[];
  paths: number[];
}

interface Element {
  bbox: Rect;
  image?: number;
  path?: number;
  /** 라벨 후보 줄(군집 다리 역할만, 도형 구성 요소로 세지 않는다). */
  text?: boolean;
  /** 회전·세로 줄(연표·축 라벨). 5개 이상 모이면 도형 근거로 본다. */
  rotated?: boolean;
  /** 본문보다 작은 글자 줄. */
  small?: boolean;
  complex: boolean;
}

/** 얇고 긴 띠(쪽 짧은 변의 5% 미만 두께, 가로세로비 8 초과): 장식. */
function isStrip(r: Rect, page: Rect): boolean {
  const w = r[2] - r[0];
  const h = r[3] - r[1];
  const short = Math.min(page[2] - page[0], page[3] - page[1]);
  return Math.min(w, h) < 0.05 * short && Math.max(w, h) > 8 * Math.min(w, h);
}

/** 산문 줄(폭이 넓고 단어가 많은 줄). */
const isProse = (f: LineFeature, w: number): boolean =>
  f.words.length >= 6 && width(f.bbox) > 0.5 * w;

export function detectFigures(
  model: PageModel,
  lines: readonly LineFeature[],
  paths: PathSummary,
  excludedPaths: ReadonlySet<number>,
): DetectedFigure[] {
  const page = model.bounds;
  const sizes = lines.map((f) => f.size).sort((a, b) => a - b);
  const bodySize = sizes.length ? sizes[sizes.length >> 1]! : 10;
  const pageArea = area(page);
  const charCenters = model.chars
    .filter((c) => c.text.trim() !== '')
    .map((c) => center(quadRect(c.quad)));
  const elements: Element[] = [];
  model.images.forEach((img, i) => {
    if (img.op === 'clip-image-mask') return;
    const r = intersect(img.bbox, page);
    if (!r || area(r) < C.imageMinArea * pageArea || area(r) > 0.9 * pageArea) return;
    const covered = charCenters.filter((p) => containsPoint(r, p)).length;
    if (charCenters.length > 20 && covered >= C.backgroundCharRatio * charCenters.length) return;
    if (isStrip(r, page)) return;
    elements.push({ bbox: r, image: i, complex: true });
  });
  const pathEls: Element[] = [];
  for (const s of paths.shapes) {
    if (excludedPaths.has(s.path)) continue;
    pathEls.push({ bbox: s.bbox, path: s.path, complex: s.complex });
  }
  for (const r of paths.rules) {
    if (excludedPaths.has(r.path)) continue;
    pathEls.push({
      bbox: [r.x0, r.y0 - r.width / 2, r.x1, r.y1 + r.width / 2],
      path: r.path,
      complex: false,
    });
  }
  for (const b of paths.boxes) {
    if (excludedPaths.has(b.path)) continue;
    pathEls.push({ bbox: b.bbox, path: b.path, complex: false });
  }
  // 쪽 밖 경로는 쪽으로 자르고(완전히 밖이면 버림), 쪽 대부분을 덮는 장식(테두리·배경)은 뺀다.
  const clipped = pathEls.flatMap((e) => {
    const r = intersect(expand(e.bbox, 0.5), page);
    return r ? [{ ...e, bbox: r }] : [];
  });
  // 짧은 줄(4단어 이하, 쪽 폭 30% 이하)은 도형 조각 사이를 잇는 다리로만 쓴다(회로도·흐름도 라벨).
  const bridges: Element[] = lines
    .filter((f) => !f.horizontal || (f.words.length <= 4 && width(f.bbox) <= 0.3 * width(page)))
    .filter((f) => !CAPTION.test(f.text))
    .map((f) => ({
      bbox: f.bbox,
      text: true,
      rotated: !f.horizontal,
      small: f.size < 0.95 * bodySize,
      complex: false,
    }));
  const els = [
    ...elements,
    ...clipped.filter(
      (e) =>
        !(width(e.bbox) > 0.9 * width(page) && e.bbox[3] - e.bbox[1] > 0.9 * (page[3] - page[1])),
    ),
    ...bridges,
  ];
  // 상자 근접 군집(union-find).
  const parent = els.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const order = els.map((_, i) => i).sort((a, b) => els[a]!.bbox[0] - els[b]!.bbox[0]);
  for (let k = 0; k < order.length; k++) {
    const a = els[order[k]!]!;
    const ea = expand(a.bbox, C.vectorJoin);
    for (let m = k + 1; m < order.length; m++) {
      const b = els[order[m]!]!;
      if (b.bbox[0] > ea[2]) break;
      if (intersect(ea, b.bbox)) parent[find(order[k]!)] = find(order[m]!);
    }
  }
  const groups = new Map<number, Element[]>();
  els.forEach((e, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), e]);
  });
  const out: DetectedFigure[] = [];
  for (const all of groups.values()) {
    const g = all.filter((e) => !e.text);
    if (g.length === 0) continue;
    let bbox = g[0]!.bbox;
    for (const e of g.slice(1)) bbox = union(bbox, e.bbox);
    // 본문보다 작은 다리 줄(축·연표 라벨)은 도형 상자에 넣는다.
    for (const e of all) if (e.text && e.small) bbox = union(bbox, e.bbox);
    const images = g.filter((e) => e.image !== undefined).map((e) => e.image!);
    const pathIds = g.filter((e) => e.path !== undefined).map((e) => e.path!);
    if (images.length === 0) {
      if (area(bbox) < C.vectorMinArea * pageArea) continue;
      const complex = g.some((e) => e.complex);
      const rotatedLabels = all.filter((e) => e.rotated).length;
      if (!complex && g.length < 8 && rotatedLabels < 5) continue;
      // 글을 담은 상자(콜아웃·사이드바)는 도형이 아니다.
      const inside = lines.filter((f) => containsPoint(bbox, center(f.bbox)));
      if (inside.filter((f) => isProse(f, width(bbox))).length >= 3) continue;
    }
    out.push({ bbox, kind: images.length ? 'image' : 'vector', images, paths: pathIds });
  }
  return mergePanels(out, lines).sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
}

/**
 * 하위 그림(패널) 합치기: 위아래(x 겹침 50% 이상) 또는 좌우(y 겹침 50% 이상)로 이웃하고 간격이 본문 글자
 * 3em 이하이며 그 사이에 산문 줄이 없으면 한 도형으로 본다(캡션 하나에 패널 여럿).
 */
function mergePanels(figs: DetectedFigure[], lines: readonly LineFeature[]): DetectedFigure[] {
  const size = lines.length
    ? lines.map((f) => f.size).sort((a, b) => a - b)[lines.length >> 1]!
    : 10;
  const maxGap = 3 * size;
  const out = figs.slice();
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!.bbox;
        const b = out[j]!.bbox;
        const ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
        const oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
        const vertical = ox >= 0.5 * Math.min(width(a), width(b)) && -oy <= maxGap;
        const horizontal = oy >= 0.5 * Math.min(a[3] - a[1], b[3] - b[1]) && -ox <= maxGap;
        if (!vertical && !horizontal) continue;
        const band = union(a, b);
        const prose = lines.some(
          (f) =>
            isProse(f, width(band)) &&
            containsPoint(band, center(f.bbox)) &&
            !containsPoint(a, center(f.bbox)) &&
            !containsPoint(b, center(f.bbox)),
        );
        if (prose) continue;
        out[i] = {
          bbox: band,
          kind: out[i]!.kind === 'image' || out[j]!.kind === 'image' ? 'image' : 'vector',
          images: [...out[i]!.images, ...out[j]!.images],
          paths: [...out[i]!.paths, ...out[j]!.paths],
        };
        out.splice(j, 1);
        changed = true;
        break outer;
      }
  }
  return out;
}

export function quadRect(q: readonly number[]): Rect {
  const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
  const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
