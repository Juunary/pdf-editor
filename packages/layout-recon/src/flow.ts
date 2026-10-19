/**
 * 흐름 텍스트 복원(계약 3절 5단계): 머리·꼬리 분리, 영역 쌓기, 영역 안 문단 나누기.
 */
import type { Rect } from '@pdf-editor/shared-types';
import { C } from './constants.js';
import { height, median, overlapX, quantile, width } from './geom.js';
import { BULLET, PAGE_NUMBER, SENTENCE_END, STARTS_UPPER } from './text-rules.js';
import { NUMBER_TAG, type Unit } from './units.js';

const TOC_ENTRY = /(?:\.\s?){4,}\s*\d{1,4}\s*$|…{2,}\s*\d{1,4}\s*$/u;

/** 같은 행: 기준선 차이가 글자 크기의 0.4배 이하(수식 줄은 상자 높이가 커서 상자 겹침으로 판단하지 않는다). */
const sameLine = (a: Unit, b: Unit): boolean =>
  Math.abs(a.baseline - b.baseline) <= 0.4 * Math.max(a.size, b.size);

/** 본문 글자 크기: 보이는 글자 수로 가중한 크기 중앙값. */
export function bodySize(units: readonly Unit[]): number {
  const sizes: number[] = [];
  for (const u of units) {
    const n = Math.min(u.text.replace(/\s/gu, '').length, 200);
    for (let i = 0; i < n; i++) sizes.push(u.size);
  }
  return sizes.length ? median(sizes) : 10;
}

export interface MarginSplit {
  header: Unit[];
  footer: Unit[];
  body: Unit[];
}

/**
 * 머리·꼬리(계약 2.5): 위·아래 여백 띠 안에 있고 본문과 marginGapEm 이상 떨어진 단위.
 * 본문보다 많이 큰 글자(제목)는 쪽 번호 형식이 아니면 제외한다. 꼬리는 짧거나(쪽 폭 60% 이하) 쪽 번호 형식만.
 */
export function splitMargins(units: readonly Unit[], bounds: Rect, body: number): MarginSplit {
  const H = height(bounds);
  const W = width(bounds);
  const topLimit = bounds[1] + C.marginBand * H;
  const bottomLimit = bounds[3] - C.marginBand * H;
  const minGap = C.marginGapEm * body;
  const inTop = (u: Unit) => u.bbox[3] <= topLimit;
  const inBottom = (u: Unit) => u.bbox[1] >= bottomLimit;
  // 긴 산문 줄(본문 크기의 8단어 이상, 쪽 폭 60% 이상)은 머리·꼬리가 아니다(쪽 위 강조 상자 등).
  const prose = (u: Unit) =>
    u.size >= 0.8 * body &&
    u.parts.reduce((n, p) => n + p.words.length, 0) >= 8 &&
    width(u.bbox) >= 0.6 * W;
  const eligible = (u: Unit) => PAGE_NUMBER.test(u.text) || (u.size <= body * 1.3 && !prose(u));
  const header = new Set<Unit>();
  const footer = new Set<Unit>();
  // 본문보다 작은 글자로만 된 머리·꼬리 묶음은 간격 기준을 절반으로 둔다.
  const gapFor = (block: Unit[]): number =>
    block.every((u) => u.size < 0.95 * body) ? minGap / 2 : minGap;
  // 위 띠: 자르기 위치 y(띠 안 단위의 아래 끝) 중, y 위 단위가 모두 띠 안·자격 있음이고 y 아래 가장 가까운
  // 단위까지 minGap 이상 떨어진 가장 낮은 위치. 그 위 단위가 머리다. 아래 띠는 대칭.
  let topCut = -Infinity;
  for (const c of units.filter(inTop)) {
    const y = c.bbox[3];
    const above = units.filter((u) => u.bbox[1] < y - 1);
    if (!above.every((u) => inTop(u) && eligible(u))) continue;
    const bottom = Math.max(...above.map((u) => u.bbox[3]));
    const below = units.filter((u) => u.bbox[1] >= bottom - 1 && !above.includes(u));
    // 아래에 본문 단위가 없으면(모든 글자가 띠 안) 머리로 판정하지 않는다.
    if (below.length === 0) continue;
    const next = below.reduce((m, u) => Math.min(m, u.bbox[1]), Infinity);
    if (next - bottom >= gapFor(above)) topCut = Math.max(topCut, bottom);
  }
  for (const u of units) if (u.bbox[3] <= topCut) header.add(u);
  let bottomCut = Infinity;
  for (const c of units.filter(inBottom)) {
    const y = c.bbox[1];
    const belowSet = units.filter((u) => u.bbox[3] > y + 1);
    const ok = belowSet.every(
      (u) =>
        inBottom(u) &&
        eligible(u) &&
        // 넓은 줄은 본문보다 많이 작은 글자(슬라이드 하단 막대 등)일 때만 꼬리로 본다(각주와 구분).
        (width(u.bbox) <= 0.6 * W || PAGE_NUMBER.test(u.text) || u.size < 0.8 * body),
    );
    if (!ok) continue;
    const top = Math.min(...belowSet.map((u) => u.bbox[1]));
    const aboveSet = units.filter((u) => u.bbox[3] <= top + 1 && !belowSet.includes(u));
    if (aboveSet.length === 0) continue;
    const prev = aboveSet.reduce((m, u) => Math.max(m, u.bbox[3]), -Infinity);
    if (top - prev >= gapFor(belowSet)) bottomCut = Math.min(bottomCut, top);
  }
  for (const u of units) if (u.bbox[1] >= bottomCut) footer.add(u);
  return {
    header: units.filter((u) => header.has(u)),
    footer: units.filter((u) => footer.has(u)),
    body: units.filter((u) => !header.has(u) && !footer.has(u)),
  };
}

export interface Region {
  units: Unit[];
  bbox: Rect;
}

const unionRect = (a: Rect, b: Rect): Rect => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];

const xFits = (a: Rect, b: Rect): boolean =>
  overlapX(a, b) >= C.stackOverlap * Math.min(width(a), width(b));

/**
 * 영역 쌓기(계약 3절 5단계): 위 단위와 x 가 겹치고 세로 간격이 작으면 같은 영역.
 * 위 단위가 아래 행의 단위 둘 이상과 겹치면(여러 열에 걸친 줄) 잇지 않는다. 장애물(표·도형) 너머로는 잇지 않는다.
 */
export function stackRegions(units: readonly Unit[], obstacles: readonly Rect[]): Region[] {
  const sorted = [...units].sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  const regions: Region[] = [];
  const regionOf = new Map<Unit, Region>();
  const blocked = (a: Rect, b: Rect): boolean =>
    obstacles.some((o) => o[1] >= a[3] - 1 && o[3] <= b[1] + 1 && overlapX(o, unionRect(a, b)) > 0);
  for (let i = 0; i < sorted.length; i++) {
    const u = sorted[i]!;
    const rowmates = sorted.filter((m) => m !== u && sameLine(m, u));
    const cands: { r: Region; gap: number }[] = [];
    for (const r of regions) {
      const last = r.units.at(-1)!;
      // 기준선 간격으로 판단한다(줄 상자 대략 1.2em 를 빼면 상자 사이 간격).
      const d = u.baseline - last.baseline;
      const size = Math.max(u.size, last.size);
      if (d > (1.2 + C.stackGapEm) * size || d < 0.5 * Math.min(u.size, last.size)) continue;
      const gap = d;
      if (!xFits(last.bbox, u.bbox)) continue;
      // 위 단위가 u 의 같은 행 다른 단위와도 겹치면 여러 열에 걸친 줄이다.
      // 겹침 기준은 낮게 둔다(넓은 제목이 오른쪽 열의 일부만 덮어도 걸친 줄이다).
      if (
        rowmates.some(
          (m) =>
            m.baseline > last.baseline + 0.5 * m.size &&
            overlapX(last.bbox, m.bbox) > 0.25 * Math.min(width(m.bbox), width(last.bbox)),
        )
      )
        continue;
      if (blocked(last.bbox, u.bbox)) continue;
      cands.push({ r, gap });
    }
    cands.sort((a, b) => a.gap - b.gap);
    const best = cands[0];
    // u 가 나란한 두 영역 위에 걸쳐 있으면(아래로 여러 열을 덮는 줄) 새 영역.
    const spans =
      best && cands.some((c) => c !== best && sameLine(c.r.units.at(-1)!, best.r.units.at(-1)!));
    if (best && !spans) {
      best.r.units.push(u);
      best.r.bbox = unionRect(best.r.bbox, u.bbox);
      regionOf.set(u, best.r);
    } else {
      const r: Region = { units: [u], bbox: u.bbox };
      regions.push(r);
      regionOf.set(u, r);
    }
  }
  return regions;
}

const firstWordAfterBullet = (u: Unit): number | null => {
  const words = u.parts.flatMap((p) => p.words);
  if (words.length < 2 || !BULLET.test(u.text)) return null;
  // 글머리 기호가 별도 조각이거나 첫 단어면 둘째 단어 시작이 본문 시작.
  return words[1]!.x0;
};

/**
 * 영역 안 문단 나누기(계약 3절 5단계). 결과는 단위 묶음(위→아래).
 */
export function splitParagraphs(region: Region, reasons?: string[]): Unit[][] {
  const us = region.units;
  if (us.length <= 1) return us.length ? [us.slice()] : [];
  // 줄 간격 기준: 글자 크기가 같은(±10%) 이웃 쌍의 기준선 간격 하위 30% 분위수. 한 영역에 모양이 다른
  // 글(강조 상자 + 목차 등)이 섞여도 각자의 간격으로 판단한다.
  const pairs: { d: number; size: number }[] = [];
  for (let i = 1; i < us.length; i++) {
    const a = us[i - 1]!;
    const b = us[i]!;
    const d = b.baseline - a.baseline;
    // 두 배 줄 간격(Word 등)까지 포함한다. 문단 사이 간격이 섞여도 하위 분위수는 문단 안 간격이다.
    if (d > 0 && d < 3.5 * Math.max(a.size, b.size) && Math.abs(a.size - b.size) <= 0.1 * b.size)
      pairs.push({ d, size: b.size });
  }
  const pitchCache = new Map<number, number>();
  const pitch = (size: number): number => {
    const key = Math.round(size * 10);
    let v = pitchCache.get(key);
    if (v === undefined) {
      const ds = pairs.filter((p) => Math.abs(p.size - size) <= 0.1 * size).map((p) => p.d);
      v = ds.length ? quantile(ds, 0.3) : Infinity;
      pitchCache.set(key, v);
    }
    return v;
  };
  const left = quantile(
    us.map((u) => u.bbox[0]),
    0.2,
  );
  const right = quantile(
    us.map((u) => u.bbox[2]),
    0.9,
  );
  const regionW = right - left;
  // 줄마다 국소 통계: 앞뒤 4줄 중 왼쪽 끝이 3em 안이거나 가로로 70% 이상 겹치는 줄(같은 열의 본문)로
  // 오른쪽 끝·왼쪽 끝·양쪽 정렬 여부를 정한다. 넓은 제목·초록과 좁은 단 본문이 한 영역에 쌓여도
  // 본문 줄을 넓은 줄 기준으로 "짧다"고 보지 않는다.
  const localStats = us.map((u, i) => {
    const em = u.size;
    const group = us.filter((v, j) => {
      if (Math.abs(i - j) > 4) return false;
      if (Math.abs(v.bbox[0] - u.bbox[0]) <= 3 * em) return true;
      const ov = Math.min(u.bbox[2], v.bbox[2]) - Math.max(u.bbox[0], v.bbox[0]);
      // 넓은 쪽 폭 기준(좁은 단 줄을 감싸는 넓은 줄은 같은 열로 보지 않는다).
      return ov >= 0.7 * Math.max(u.bbox[2] - u.bbox[0], v.bbox[2] - v.bbox[0]);
    });
    const r = quantile(
      group.map((v) => v.bbox[2]),
      0.9,
    );
    const l = quantile(
      group.map((v) => v.bbox[0]),
      0.2,
    );
    const flushN = group.filter((v) => v.bbox[2] >= r - 0.5 * v.size).length;
    return {
      left: l,
      right: r,
      regionW: r - l,
      justified: group.length >= 4 && flushN >= 0.6 * group.length,
    };
  });
  // 표시 수식 줄: 수식 비율 40% 이상이고 짧은(쪽 폭 대신 영역 폭 85% 미만) 줄, 그 옆·아래의 식 번호.
  const isMath = us.map(
    (u) => u.math >= 0.4 && u.bbox[2] - u.bbox[0] < 0.85 * Math.max(regionW, 1),
  );
  us.forEach((u, i) => {
    if (!isMath[i] && NUMBER_TAG.test(u.text) && (isMath[i - 1] || isMath[i + 1])) isMath[i] = true;
  });
  const paras: Unit[][] = [[us[0]!]];
  for (let i = 1; i < us.length; i++) {
    const a = us[i - 1]!;
    const b = us[i]!;
    const cur = paras.at(-1)!;
    let why: string | null;
    if (isMath[i - 1] && isMath[i]) {
      // 같은 표시 수식의 줄(분수·첨자·식 번호)은 간격이 크지 않으면 한 문단.
      why = b.baseline - a.baseline > 3 * Math.max(a.size, b.size) ? 'math-gap' : null;
    } else if (isMath[i - 1] !== isMath[i]) {
      why = 'math-boundary';
    } else why = breakReason(a, b, cur, { pitch, ...localStats[i - 1]! });
    reasons?.push(why ?? '');
    if (why) paras.push([b]);
    else cur.push(b);
  }
  return paras;
}

interface RegionStats {
  justified: boolean;
  pitch: (size: number) => number;
  left: number;
  right: number;
  regionW: number;
}

const firstWordWidth = (u: Unit, em: number): number => {
  const w = u.parts[0]?.words[0];
  return w ? w.x1 - w.x0 : em;
};

/** 문단을 나눌 이유(없으면 null). */
function breakReason(a: Unit, b: Unit, cur: Unit[], s: RegionStats): string | null {
  const em = Math.max(a.size, b.size);
  const indent = C.indentEm * Math.min(a.size, b.size);
  // 크기·굵기·색 변화.
  if (Math.abs(a.size - b.size) / em >= C.sizeChangeRatio) return 'size';
  if (a.bold !== b.bold) return 'bold';
  if (a.color && b.color && a.color.some((v, k) => Math.abs(v - b.color![k]!) > 0.15))
    return 'color';
  // 간격.
  const d = b.baseline - a.baseline;
  // 흡수한 큰 연산자·첨자로 늘어난 줄 높이만큼은 간격에서 뺀다.
  const tall = (u: Unit) => Math.max(0, u.full[3] - u.full[1] - (u.bbox[3] - u.bbox[1]));
  const dd = d - (tall(a) + tall(b)) / 2;
  if (dd > s.pitch(b.size) * C.paraPitchRatio + 0.5 && dd > 1.05 * b.size) return 'pitch';
  // 글머리.
  // 글머리: 앞 줄이 끝까지 차고 문장이 이어지며 지금 문단이 목록 항목이 아니면 본문 안의 "(b)" 같은 참조로 본다.
  if (BULLET.test(b.text)) {
    const inline =
      a.bbox[2] >= s.right - 0.5 * em && !SENTENCE_END.test(a.text) && !BULLET.test(cur[0]!.text);
    if (!inline) return 'bullet';
  }
  // 목차 항목(점 끈 + 쪽 번호)은 줄마다 문단.
  if (TOC_ENTRY.test(a.text)) return 'toc';
  const hyphen = /[-‐]$/u.test(a.text);
  // 가운데 정렬 줄(가운데가 맞고 왼쪽이 영역 왼쪽보다 들어감)은 들여쓰기로 보지 않는다.
  const centered =
    Math.abs((a.bbox[0] + a.bbox[2]) / 2 - (b.bbox[0] + b.bbox[2]) / 2) <= 0.5 * em &&
    Math.min(a.bbox[0], b.bbox[0]) > s.left + indent;
  if (!centered) {
    if (cur.length === 1) {
      if (b.bbox[0] > a.bbox[0] + indent) {
        const after = firstWordAfterBullet(a);
        const words = BULLET.test(a.text) ? a.parts.flatMap((p) => p.words).slice(1, 6) : [];
        const hanging =
          (after !== null && Math.abs(b.bbox[0] - after) <= 0.6 * em) ||
          words.some((w) => Math.abs(w.x0 - b.bbox[0]) <= 1.5) ||
          // 글머리 첫 줄이 오른쪽 끝까지 차고 다음 줄이 들어가 있으면 내어쓰기 이어짐.
          (BULLET.test(a.text) && a.bbox[2] >= s.right - 0.5 * em) ||
          // 글머리 첫 줄 뒤에 다음 줄 첫 단어가 들어갈 자리가 없으면 넘긴 줄이다.
          (BULLET.test(a.text) && s.right - a.bbox[2] < firstWordWidth(b, em) + 0.3 * em);
        if (!hanging) return 'indent-first';
      }
    } else {
      const paraLeft = median(cur.slice(1).map((u) => u.bbox[0]));
      if (b.bbox[0] > paraLeft + indent) return 'indent-in';
      if (b.bbox[0] < paraLeft - indent) return 'outdent';
    }
  }
  if (hyphen) return null;
  // 앞 줄이 일찍 끝남: 다음 줄 첫 단어가 앞 줄 남은 자리에 들어가면 자동 줄바꿈이 아니다.
  if (s.regionW > 8 * em) {
    const firstWord = b.parts[0]?.words[0];
    const wordW = firstWord ? firstWord.x1 - firstWord.x0 : em;
    const room = s.right - a.bbox[2];
    const short = room > Math.max(wordW + 0.3 * em, C.shortLineRatio * s.regionW * 0.5);
    if (short) {
      if (SENTENCE_END.test(a.text)) return 'sentence-end';
      if (s.justified && !centered) return 'short-justified';
      if (STARTS_UPPER.test(b.text) && !centered) return 'upper';
      if (a.bbox[2] < s.left + 0.6 * s.regionW && !centered) return 'very-short';
    }
  }
  return null;
}
