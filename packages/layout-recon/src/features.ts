/**
 * 줄 특징(layout-recon 내부 입력). PageModel.lines 하나당 LineFeature 하나.
 * 단어·구간 상자는 글자 quad 의 x 범위로 만든다(가로쓰기 기준). 세로·회전 줄은 horizontal=false.
 */
import type { PageModel, Rect } from '@pdf-editor/shared-types';

export interface Box {
  x0: number;
  x1: number;
  /** PageModel.chars 인덱스(이 상자 안, 줄 안 순서). */
  chars: number[];
  text: string;
}

export interface LineFeature {
  /** PageModel.lines 인덱스. */
  index: number;
  bbox: Rect;
  /** 읽기 텍스트(spaceAfter 반영, 줄 끝 공백 제거). */
  text: string;
  /** 글자 크기 중앙값(pt). */
  size: number;
  /** 글자 수 기준 다수 폰트. */
  fontId: number;
  bold: boolean;
  italic: boolean;
  /** 기준선 y 중앙값(페이지 공간). */
  baseline: number;
  /** 줄 진행 방향이 거의 (1, 0) 인지. */
  horizontal: boolean;
  /** PageModel.chars 인덱스, 줄 안 순서. */
  chars: number[];
  /** 공백(글자·spaceAfter)으로 나눈 단어 상자. */
  words: Box[];
  /** 큰 간격(글자 크기의 1.5배 초과)으로 나눈 구간 상자. 표의 셀·다단 줄을 가르는 데 쓴다. */
  segments: Box[];
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

function quadX(q: number[]): [number, number] {
  return [Math.min(q[0]!, q[2]!, q[4]!, q[6]!), Math.max(q[0]!, q[2]!, q[4]!, q[6]!)];
}

function splitBoxes(
  model: PageModel,
  chars: number[],
  spaceAfter: Set<number>,
  gapLimit: number,
  splitOnSpace: boolean,
): Box[] {
  const boxes: Box[] = [];
  let cur: Box | null = null;
  let prevX1 = -Infinity;
  chars.forEach((ci, k) => {
    const c = model.chars[ci]!;
    const isSpace = c.text.trim() === '';
    const [x0, x1] = quadX(c.quad);
    const gap = x0 - prevX1;
    if (isSpace) {
      if (splitOnSpace) cur = null;
      else if (cur) {
        cur.chars.push(ci);
        cur.text += c.text;
      }
      prevX1 = Math.max(prevX1, x1);
      return;
    }
    if (!cur || gap > gapLimit) {
      cur = { x0, x1, chars: [], text: '' };
      boxes.push(cur);
    }
    cur.chars.push(ci);
    cur.text += c.text;
    cur.x0 = Math.min(cur.x0, x0);
    cur.x1 = Math.max(cur.x1, x1);
    prevX1 = x1;
    if (spaceAfter.has(k)) {
      if (splitOnSpace) cur = null;
      else cur.text += ' ';
    }
  });
  for (const b of boxes) b.text = b.text.trim();
  return boxes;
}

export function lineFeatures(model: PageModel): LineFeature[] {
  return model.lines.map((line, index) => {
    const chars = line.chars;
    const spaceAfter = new Set(line.spaceAfter);
    const cs = chars.map((i) => model.chars[i]!);
    const visible = cs.filter((c) => c.text.trim() !== '');
    const sizes = visible.map((c) => c.size);
    const size = median(sizes.length ? sizes : cs.map((c) => c.size));
    const fontCount = new Map<number, number>();
    for (const c of visible) fontCount.set(c.fontId, (fontCount.get(c.fontId) ?? 0) + 1);
    const fontId =
      [...fontCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? cs[0]?.fontId ?? 0;
    const font = model.fonts[fontId];
    let text = '';
    chars.forEach((ci, k) => {
      text += model.chars[ci]!.text;
      if (spaceAfter.has(k)) text += ' ';
    });
    const horizontal = Math.abs(line.dir[1]) < 0.05 && line.dir[0] > 0 && line.wmode === 0;
    return {
      index,
      bbox: line.bbox,
      text: text.replace(/\s+$/u, ''),
      size,
      fontId,
      bold: font?.bold ?? false,
      italic: font?.italic ?? false,
      baseline: median(visible.map((c) => c.origin[1])),
      horizontal,
      chars,
      words: splitBoxes(model, chars, spaceAfter, Math.max(size * 0.5, 1), true),
      segments: splitBoxes(model, chars, spaceAfter, Math.max(size * 1.5, 3), false),
    };
  });
}

/**
 * 추출 지문 원문: 줄 텍스트(lineFeatures 규칙)를 "\n" 으로 이은 문자열. 라벨의 linesSha256 은 이 문자열의
 * UTF-8 SHA-256 이다(docs/m2-contract.md 4.1). 해시는 호출자가 계산한다(이 패키지는 암호 모듈에 의존하지 않음).
 */
export function fingerprintText(model: PageModel): string {
  return lineFeatures(model)
    .map((f) => f.text)
    .join('\n');
}
