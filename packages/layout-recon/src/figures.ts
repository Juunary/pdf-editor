/**
 * Figure detection (contract section 3, step 4): large images and vector path clusters. Table rules and backgrounds, and background boxes that contain text, are excluded.
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
  /** Label candidate lines (serve only as cluster bridges, not counted as figure components). */
  text?: boolean;
  /** Rotated or vertical lines (timeline and axis labels). Five or more of them count as evidence of a figure. */
  rotated?: boolean;
  /** Lines with text smaller than body text. */
  small?: boolean;
  complex: boolean;
}

/** Thin, long strip (thickness under 5% of the page's short side, aspect ratio over 8): decoration. */
function isStrip(r: Rect, page: Rect): boolean {
  const w = r[2] - r[0];
  const h = r[3] - r[1];
  const short = Math.min(page[2] - page[0], page[3] - page[1]);
  return Math.min(w, h) < 0.05 * short && Math.max(w, h) > 8 * Math.min(w, h);
}

/** Prose line (wide line with many words). */
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
    // An image covering three or more prose lines is a background (body text over a photo, sidebar).
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
  // Paths outside the page are clipped to the page (dropped if entirely outside), and decorations covering most of the page (borders, backgrounds) are excluded.
  const clipped = pathEls.flatMap((e) => {
    const r = intersect(expand(e.bbox, 0.5), page);
    return r ? [{ ...e, bbox: r }] : [];
  });
  // Short lines (at most 4 words, at most 30% of page width) are used only as bridges between figure pieces (circuit and flowchart labels).
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
  // Clustering by box proximity (union-find).
  const parent = els.map((_, i) => i);
  // Iterative find (path halving). Recursion overflows the call stack on long chains.
  const find = (i: number): number => {
    let x = i;
    for (let guard = 0; parent[x] !== x; guard++) {
      if (guard > parent.length) throw new Error(`도형 군집 순환: ${i}`);
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  // Compares only neighbor candidates via a spatial grid index (avoids pairwise comparison on pages with tens of thousands of paths).
  // Cell size: 2x the median element size + joining distance (8–48pt). Keeps the candidates per cell few even in dense areas.
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
    // Bridge lines smaller than body text (axis and timeline labels) go into the figure box.
    for (const e of all) if (e.text && e.small) bbox = union(bbox, e.bbox);
    const images = g.filter((e) => e.image !== undefined).map((e) => e.image!);
    const pathIds = g.filter((e) => e.path !== undefined).map((e) => e.path!);
    if (images.length === 0) {
      if (area(bbox) < C.vectorMinArea * pageArea) continue;
      const complex = g.some((e) => e.complex);
      const rotatedLabels = all.filter((e) => e.rotated).length;
      if (!complex && g.length < 8 && rotatedLabels < 5) continue;
      // A box that contains text (callout, sidebar) is not a figure.
      const inside = lines.filter((f) => containsPoint(bbox, center(f.bbox)));
      if (inside.filter((f) => isProse(f, width(bbox))).length >= 3) continue;
    }
    out.push({ bbox, kind: images.length ? 'image' : 'vector', images, paths: pathIds });
  }
  return mergePanels(out, lines).sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
}

/**
 * Merging sub-figures (panels): neighbors above/below (x overlap at least 50%) or left/right (y overlap at least 50%) whose gap is at most 3em of body
 * font size, with no prose line between them, are treated as one figure (several panels under one caption).
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

/** Above this count, clustering uses the occupancy grid approximation (worst-case time bound for charts with tens of thousands of paths). */
const DENSE_ELEMENTS = 4000;

/**
 * Occupancy grid clustering (approximate): divides the page into cells of size C.vectorJoin and marks the cells covered by element boxes (expanded by half the joining distance),
 * then treats 4-neighbor connected components of marked cells as clusters. Writes the cluster representative (first element) of element i into parent[i].
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
  // 1) Mark cells (the first marking element is the temporary owner).
  els.forEach((e, i) => {
    const [x0, y0, x1, y1] = span(e.bbox);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if (owner[y * cols + x] === -1) owner[y * cols + x] = i;
  });
  // 2) Connected components of marked cells (BFS); pick an element representative per cell.
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
  // 3) Element → cluster representative (connected component of the cell at the element box center; itself if outside the page).
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
