/**
 * 도형 검출(계약 3절 4단계): 큰 이미지와 벡터 경로 군집. 표 괘선·배경, 글을 담은 배경 상자는 뺀다.
 */
import type { PageModel, Rect } from '@pdf-editor/shared-types';
import { C } from './constants.js';
import { CAPTION } from './text-rules.js';
import type { LineFeature } from './features.js';
import { GridIndex, area, center, containsPoint, expand, intersect, union, width } from './geom.js';
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
    // 산문 줄 3개 이상을 덮는 이미지는 배경(사진 위 본문·사이드바)이다.
    const prose = lines.filter((f) => isProse(f, width(r)) && containsPoint(r, center(f.bbox)));
    if (prose.length >= 3) return;
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
  // 반복문 find(경로 절반 줄이기). 재귀는 긴 사슬에서 호출 스택을 넘긴다.
  const find = (i: number): number => {
    let x = i;
    for (let guard = 0; parent[x] !== x; guard++) {
      if (guard > parent.length) throw new Error(`도형 군집 순환: ${i}`);
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  // 공간 격자 색인으로 이웃 후보만 비교한다(경로 수만 개 쪽에서 쌍별 비교를 피한다).
  // 칸 크기: 요소 크기 중앙값 2배 + 이음 거리(8–48pt). 밀집 영역에서도 칸당 후보가 적게 한다.
  const elSizes = els
    .map((e) => Math.max(e.bbox[2] - e.bbox[0], e.bbox[3] - e.bbox[1]))
    .sort((a, b) => a - b);
  const typical = elSizes.length ? elSizes[elSizes.length >> 1]! : 10;
  const index = new GridIndex(Math.min(48, Math.max(8, 2 * typical + C.vectorJoin)));
  els.forEach((e, i) => index.insert(i, e.bbox));
  if (els.length > DENSE_ELEMENTS) {
    clusterByOccupancy(els, page, parent);
  } else {
    const stamp = new Int32Array(els.length).fill(-1);
    els.forEach((a, i) => {
      const ea = expand(a.bbox, C.vectorJoin);
      index.forEach(ea, stamp, i, (j) => {
        if (j <= i) return;
        const ra = find(i);
        const rb = find(j);
        if (ra !== rb && intersect(ea, els[j]!.bbox)) parent[ra] = rb;
      });
    });
  }
  const groups = new Map<number, Element[]>();
  els.forEach((e, i) => {
    const r = find(i);
    const list = groups.get(r);
    if (list) list.push(e);
    else groups.set(r, [e]);
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

/** 이 개수를 넘으면 점유 격자 근사로 군집한다(경로 수만 개 차트 쪽의 최악 시간 상한). */
const DENSE_ELEMENTS = 4000;

/**
 * 점유 격자 군집(근사): 쪽을 C.vectorJoin 크기 칸으로 나눠 요소 상자(이음 거리 절반만큼 확장)가 덮는 칸을
 * 표시하고, 표시 칸의 4-이웃 연결 요소를 군집으로 본다. parent[i] 에 요소 i 의 군집 대표(첫 요소)를 쓴다.
 */
function clusterByOccupancy(els: readonly Element[], page: Rect, parent: number[]): void {
  const cell = C.vectorJoin;
  const cols = Math.max(1, Math.ceil((page[2] - page[0]) / cell));
  const rows = Math.max(1, Math.ceil((page[3] - page[1]) / cell));
  const owner = new Int32Array(cols * rows).fill(-1);
  const span = (r: Rect): [number, number, number, number] => {
    const e = expand(r, C.vectorJoin / 2);
    return [
      Math.max(0, Math.floor((e[0] - page[0]) / cell)),
      Math.max(0, Math.floor((e[1] - page[1]) / cell)),
      Math.min(cols - 1, Math.floor((e[2] - page[0]) / cell)),
      Math.min(rows - 1, Math.floor((e[3] - page[1]) / cell)),
    ];
  };
  // 1) 칸 표시(첫 표시 요소를 임시 소유자로).
  els.forEach((e, i) => {
    const [x0, y0, x1, y1] = span(e.bbox);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if (owner[y * cols + x] === -1) owner[y * cols + x] = i;
  });
  // 2) 표시 칸 연결 요소(BFS), 칸마다 요소 대표를 정한다.
  const comp = new Int32Array(cols * rows).fill(-1);
  const queue = new Int32Array(cols * rows);
  for (let s = 0; s < owner.length; s++) {
    if (owner[s] === -1 || comp[s] !== -1) continue;
    const rep = owner[s]!;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    comp[s] = rep;
    while (head < tail) {
      const c = queue[head++]!;
      const x = c % cols;
      const y = (c - x) / cols;
      const next = [
        x > 0 ? c - 1 : -1,
        x < cols - 1 ? c + 1 : -1,
        y > 0 ? c - cols : -1,
        y < rows - 1 ? c + cols : -1,
      ];
      for (const n of next) {
        if (n < 0 || owner[n] === -1 || comp[n] !== -1) continue;
        comp[n] = rep;
        queue[tail++] = n;
      }
    }
  }
  // 3) 요소 → 군집 대표(요소 상자 중심 칸의 연결 요소, 쪽 밖이면 자기 자신).
  els.forEach((e, i) => {
    const [x0, y0, x1, y1] = span(e.bbox);
    const c = Math.floor((y0 + y1) / 2) * cols + Math.floor((x0 + x1) / 2);
    const rep = comp[c] ?? -1;
    parent[i] = rep >= 0 ? rep : i;
  });
  for (let i = 0; i < parent.length; i++)
    if (parent[parent[i]!] !== parent[i]) parent[parent[i]!] = parent[i]!;
}

export function quadRect(q: readonly number[]): Rect {
  const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
  const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
