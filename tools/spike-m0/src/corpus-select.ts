import * as mupdf from 'mupdf';
import type { Rect } from '@pdf-editor/shared-types';

/**
 * 실제 문서에서 본문 문단을 자동으로 고른다(Day 1 하드코딩 좌표의 일반화, docs/m0-corpus-recheck.md 2절).
 * MuPDF stext 블록을 문단 후보로 보고, 본문 글자 크기·줄 정렬·줄 간격·글자 비율로 거른 뒤
 * 다른 블록 글자와 겹치지 않는 redaction 영역을 만든다. 좌표는 모두 MuPDF 페이지 좌표(원점 좌상단).
 *
 * MuPDF redaction 은 글리프 외곽(잉크 범위)과 영역이 조금이라도 겹치면 그 글자를 지운다(실측 2026-10-19:
 * 글자 중심이 영역 밖이어도 제거, stext quad 의 위·아래 여백만 겹치면 유지). 그래서 영역과 겹침 판정은
 * quad 가 아니라 기준선 기준 추정 잉크 범위(위 0.8em, 아래 0.22em)로 한다.
 */

export interface StextChar {
  c: string;
  /** 기준선 원점 */
  x: number;
  y: number;
  size: number;
  font: string;
  /** quad 외접 사각형 */
  box: Rect;
}

export interface StextLine {
  bbox: Rect;
  wmode: number;
  dir: [number, number];
  chars: StextChar[];
}

export interface StextBlock {
  bbox: Rect;
  lines: StextLine[];
}

const INK_ASCENT = 0.8;
const INK_DESCENT = 0.22;

const quadBox = (q: mupdf.Quad): Rect => [
  Math.min(q[0], q[2], q[4], q[6]),
  Math.min(q[1], q[3], q[5], q[7]),
  Math.max(q[0], q[2], q[4], q[6]),
  Math.max(q[1], q[3], q[5], q[7]),
];

export function readTextBlocks(page: mupdf.Page): StextBlock[] {
  const blocks: StextBlock[] = [];
  const stext = page.toStructuredText('preserve-whitespace');
  try {
    stext.walk({
      beginTextBlock: (bbox) => void blocks.push({ bbox: [...bbox] as Rect, lines: [] }),
      beginLine: (bbox, wmode, dir) =>
        void blocks.at(-1)?.lines.push({
          bbox: [...bbox] as Rect,
          wmode,
          dir: [dir[0], dir[1]],
          chars: [],
        }),
      onChar: (c, origin, font, size, quad) =>
        void blocks
          .at(-1)
          ?.lines.at(-1)
          ?.chars.push({
            c,
            x: origin[0],
            y: origin[1],
            size,
            font: font.getName(),
            box: quadBox(quad),
          }),
    });
  } finally {
    stext.destroy();
  }
  return blocks;
}

export const lineText = (l: StextLine) => l.chars.map((c) => c.c).join('');
const isSpace = (c: string) => /^\s$/u.test(c);

/** 추정 잉크 범위(글자 위아래로 quad 보다 좁다). 공백은 null. */
function inkBox(ch: StextChar): Rect | null {
  if (isSpace(ch.c)) return null;
  return [ch.box[0], ch.y - INK_ASCENT * ch.size, ch.box[2], ch.y + INK_DESCENT * ch.size];
}

export const rectsIntersect = (a: Rect, b: Rect) =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

export const unionRect = (a: Rect, b: Rect): Rect => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface ParagraphCandidate {
  pageIndex: number;
  blockIndex: number;
  /** redaction 영역 = 블록 글자 추정 잉크 범위의 합(여유 0.5pt) */
  rect: Rect;
  /** 줄별 텍스트·기준선·가로 범위 */
  lines: { text: string; baseline: number; x0: number; x1: number }[];
  text: string;
  /** 글자 크기 중앙값(pt) */
  fontSize: number;
  /** 기준선 간격 중앙값(pt) */
  linePitch: number;
  fonts: string[];
  /** 공백 제외 글자 수 */
  charCount: number;
  hangulRatio: number;
  /** U+FFFD·사용자 정의 영역 문자 비율(문자 매핑 복원 곤란 지표) */
  unmappedRatio: number;
}

export type RejectReason =
  | 'too-few-lines'
  | 'too-few-chars'
  | 'not-horizontal'
  | 'font-size-off-body'
  | 'mixed-font-size'
  | 'low-letter-ratio'
  | 'ragged-left'
  | 'irregular-line-pitch'
  | 'header-footer-band'
  | 'overlaps-other-text';

export interface PageScan {
  pageIndex: number;
  rotation: number;
  blocks: number;
  candidates: number;
}

export interface SelectionReport {
  pageCount: number;
  scannedPages: PageScan[];
  /** 훑은 쪽의 글자 수 가중 최빈 글자 크기(0.5pt 단위) */
  bodyFontSize: number | null;
  /** 회전(/Rotate ≠ 0)이라 건너뛴 쪽 수(훑은 쪽 중) */
  rotatedSkipped: number;
  rejected: Partial<Record<RejectReason, number>>;
  selected: ParagraphCandidate[];
}

interface ScannedPage {
  pageIndex: number;
  height: number;
  blocks: StextBlock[];
}

/** 문단 후보 판정. null 이면 후보, 아니면 탈락 사유. */
export function judgeBlock(
  block: StextBlock,
  others: StextBlock[],
  pageHeight: number,
  bodySize: number | null,
): { reason: RejectReason } | { candidate: Omit<ParagraphCandidate, 'pageIndex' | 'blockIndex'> } {
  const lines = block.lines.filter((l) => l.chars.some((c) => !isSpace(c.c)));
  if (lines.length < 3) return { reason: 'too-few-lines' };
  if (
    lines.some((l) => l.wmode !== 0 || Math.abs(l.dir[0] - 1) > 1e-3 || Math.abs(l.dir[1]) > 1e-3)
  )
    return { reason: 'not-horizontal' };
  const chars = lines.flatMap((l) => l.chars).filter((c) => !isSpace(c.c));
  if (chars.length < 80) return { reason: 'too-few-chars' };
  const size = median(chars.map((c) => c.size));
  if (bodySize !== null && Math.abs(size - bodySize) > Math.max(0.6, bodySize * 0.15))
    return { reason: 'font-size-off-body' };
  const sameSize = chars.filter((c) => Math.abs(c.size - size) <= 0.6).length / chars.length;
  if (sameSize < 0.9) return { reason: 'mixed-font-size' };
  const letters = chars.filter((c) => /\p{L}/u.test(c.c)).length / chars.length;
  if (letters < 0.6) return { reason: 'low-letter-ratio' };
  const x0 = Math.min(...lines.map((l) => l.chars[0]!.box[0]));
  const aligned = lines.filter((l) => Math.abs(l.chars[0]!.box[0] - x0) <= 2 * size).length;
  if (aligned / lines.length < 0.8) return { reason: 'ragged-left' };
  const baselines = lines.map((l) => median(l.chars.map((c) => c.y)));
  const gaps = baselines.slice(1).map((b, i) => b - baselines[i]!);
  const pitch = median(gaps);
  if (
    !(pitch >= 0.95 * size && pitch <= 2.4 * size) ||
    gaps.some((g) => Math.abs(g - pitch) > 0.25 * pitch)
  )
    return { reason: 'irregular-line-pitch' };
  if (block.bbox[1] < pageHeight * 0.05 || block.bbox[3] > pageHeight * 0.95)
    return { reason: 'header-footer-band' };

  let rect: Rect | null = null;
  for (const ch of chars) {
    const ink = inkBox(ch);
    if (ink) rect = rect ? unionRect(rect, ink) : ink;
  }
  rect = [rect![0] - 0.5, rect![1] - 0.5, rect![2] + 0.5, rect![3] + 0.5];
  const intrudes = others.some((o) =>
    o.lines.some((l) =>
      l.chars.some((ch) => {
        const ink = inkBox(ch);
        return ink !== null && rectsIntersect(ink, rect!);
      }),
    ),
  );
  if (intrudes) return { reason: 'overlaps-other-text' };

  const text = lines.map(lineText).join('\n');
  const nonSpace = [...text].filter((c) => !isSpace(c) && c !== '\n');
  return {
    candidate: {
      rect,
      lines: lines.map((l, i) => {
        const ink = l.chars.filter((c) => !isSpace(c.c));
        return {
          text: lineText(l),
          baseline: baselines[i]!,
          x0: Math.min(...ink.map((c) => c.box[0])),
          x1: Math.max(...ink.map((c) => c.box[2])),
        };
      }),
      text,
      fontSize: size,
      linePitch: pitch,
      fonts: [...new Set(chars.map((c) => c.font))],
      charCount: nonSpace.length,
      hangulRatio: nonSpace.filter((c) => /\p{Script=Hangul}/u.test(c)).length / nonSpace.length,
      unmappedRatio: nonSpace.filter((c) => c === '�' || /[-]/u.test(c)).length / nonSpace.length,
    },
  };
}

/**
 * 쪽 훑기 구간: 표지(0쪽) 다음부터 문서 15%·50%·85% 지점에서 시작해 앞으로 `perStart` 쪽씩, 마지막 구간은
 * 나머지 쪽(앞에서부터, 전체 60쪽 상한). 쪽은 중복되지 않는다.
 */
export function scanSegments(pageCount: number, perStart = 12): number[][] {
  if (pageCount <= 1) return [[0]];
  const seen = new Set<number>();
  const take = (from: number, to: number, limit: number) => {
    const seg: number[] = [];
    for (let p = from; p < to && seen.size < limit; p++) {
      if (!seen.has(p)) {
        seen.add(p);
        seg.push(p);
      }
    }
    return seg;
  };
  const segments = [0.15, 0.5, 0.85].map((f) => {
    const start = Math.max(1, Math.floor((pageCount - 1) * f));
    return take(start, Math.min(pageCount, start + perStart), Infinity);
  });
  segments.push(take(0, pageCount, 60));
  return segments;
}

/**
 * 문서에서 본문 문단을 최대 `max` 개 고른다(서로 다른 쪽, 훑기 순서의 세 구간에서 하나씩 우선).
 * 회전된 쪽은 건너뛴다(편집 배치가 PDF 사용자 공간 가로쓰기 전제).
 */
export function selectParagraphs(doc: mupdf.PDFDocument, max = 3): SelectionReport {
  const pageCount = doc.countPages();
  const segments = scanSegments(pageCount);
  const order = segments.flat();
  const scanned: ScannedPage[] = [];
  const scans: PageScan[] = [];
  let rotatedSkipped = 0;
  for (const p of order) {
    const rot = doc.findPage(p).getInheritable('Rotate');
    const rotation = rot.isNull() ? 0 : ((rot.asNumber() % 360) + 360) % 360;
    if (rotation !== 0) {
      rotatedSkipped++;
      scans.push({ pageIndex: p, rotation, blocks: 0, candidates: 0 });
      continue;
    }
    const page = doc.loadPage(p);
    const bounds = page.getBounds();
    scanned.push({ pageIndex: p, height: bounds[3] - bounds[1], blocks: readTextBlocks(page) });
    page.destroy();
  }

  const hist = new Map<number, number>();
  for (const s of scanned)
    for (const b of s.blocks)
      for (const l of b.lines)
        for (const c of l.chars) {
          if (isSpace(c.c)) continue;
          const k = Math.round(c.size * 2) / 2;
          hist.set(k, (hist.get(k) ?? 0) + 1);
        }
  const bodyFontSize = hist.size ? [...hist].sort((a, b) => b[1] - a[1])[0]![0] : null;

  const rejected: SelectionReport['rejected'] = {};
  const byPage = new Map<number, ParagraphCandidate[]>();
  for (const s of scanned) {
    const found: ParagraphCandidate[] = [];
    s.blocks.forEach((b, i) => {
      const r = judgeBlock(
        b,
        s.blocks.filter((o) => o !== b),
        s.height,
        bodyFontSize,
      );
      if ('reason' in r) rejected[r.reason] = (rejected[r.reason] ?? 0) + 1;
      else found.push({ pageIndex: s.pageIndex, blockIndex: i, ...r.candidate });
    });
    byPage.set(s.pageIndex, found);
    scans.push({
      pageIndex: s.pageIndex,
      rotation: 0,
      blocks: s.blocks.length,
      candidates: found.length,
    });
  }

  // 구간마다 하나씩 먼저 고르고, 모자라면 나머지 쪽에서 채운다. 같은 쪽에서는 하나만, 5줄 근처 우선.
  const best = (cs: ParagraphCandidate[]) =>
    [...cs].sort((a, b) => Math.abs(a.lines.length - 5) - Math.abs(b.lines.length - 5))[0];
  const selected: ParagraphCandidate[] = [];
  const used = new Set<number>();
  const pick = (pages: number[]) => {
    for (const p of pages) {
      const c = best(byPage.get(p) ?? []);
      if (c && !used.has(p)) {
        used.add(p);
        selected.push(c);
        return true;
      }
    }
    return false;
  };
  for (const seg of segments.slice(0, 3)) if (selected.length < max) pick(seg);
  while (selected.length < max && pick(order)) {
    // 남은 쪽에서 채운다
  }
  return {
    pageCount,
    scannedPages: scans.sort((a, b) => a.pageIndex - b.pageIndex),
    bodyFontSize,
    rotatedSkipped,
    rejected,
    selected,
  };
}
