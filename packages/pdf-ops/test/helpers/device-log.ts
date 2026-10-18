/**
 * 테스트 전용: `runPageContents`(항등 행렬) Device 콜백을 순서대로 기록한다. 패키지에서 내보내지 않는다.
 * 텍스트 콜백은 글리프 유니코드를 이어 붙인 문자열과 텍스트 객체 포인터를 남긴다.
 */
import * as mupdf from 'mupdf';

export interface DeviceEvent {
  kind: string;
  /** 텍스트 콜백만: 글리프 유니코드 연결. */
  text?: string;
  /** 텍스트 콜백만: fz_text 포인터. */
  pointer?: number;
  /** 텍스트 콜백만: 글리프별 [gid, trm 6값]. */
  glyphs?: number[][];
}

const OTHER = [
  'popClip',
  'beginMask',
  'endMask',
  'beginGroup',
  'endGroup',
  'endTile',
  'beginLayer',
  'endLayer',
] as const;

export function recordDevice(page: mupdf.Page): DeviceEvent[] {
  const events: DeviceEvent[] = [];
  // 콜백 인자로 받은 Text 를 붙잡아 두어 포인터가 재사용되지 않게 한다.
  const held: mupdf.Text[] = [];
  const text = (kind: string) => (t: mupdf.Text) => {
    held.push(t);
    const glyphs: number[][] = [];
    let s = '';
    t.walk({
      showGlyph: (_f, trm, gid, uni) => {
        glyphs.push([gid, ...trm]);
        s += String.fromCodePoint(uni);
      },
    });
    events.push({ kind, text: s, pointer: t.pointer, glyphs });
  };
  const other = (kind: string) => () => void events.push({ kind });
  const device = new mupdf.Device({
    fillText: text('fillText'),
    strokeText: text('strokeText'),
    clipText: text('clipText'),
    clipStrokeText: text('clipStrokeText'),
    ignoreText: text('ignoreText'),
    fillPath: other('fillPath'),
    strokePath: other('strokePath'),
    clipPath: other('clipPath'),
    clipStrokePath: other('clipStrokePath'),
    fillShade: other('fillShade'),
    fillImage: other('fillImage'),
    fillImageMask: other('fillImageMask'),
    clipImageMask: other('clipImageMask'),
    popClip: other('popClip'),
    beginMask: other('beginMask'),
    endMask: other('endMask'),
    beginGroup: other('beginGroup'),
    endGroup: other('endGroup'),
    beginTile: () => {
      events.push({ kind: 'beginTile' });
      return 0;
    },
    endTile: other('endTile'),
    beginLayer: other('beginLayer'),
    endLayer: other('endLayer'),
  });
  page.runPageContents(device, mupdf.Matrix.identity);
  device.close();
  return events;
}

/** 비교용 짧은 표기: 텍스트는 "fill:Ab", 같은 포인터 연속은 "stroke=:Ab", 그 밖은 콜백 이름. */
export function brief(events: readonly DeviceEvent[], skip: readonly string[] = OTHER): string[] {
  const out: string[] = [];
  let last: number | undefined;
  for (const e of events) {
    if (e.pointer === undefined) {
      if (!skip.includes(e.kind)) out.push(e.kind);
      last = undefined;
      continue;
    }
    const same = e.pointer === last ? '=' : '';
    out.push(`${e.kind.replace('Text', '')}${same}:${e.text}`);
    last = e.pointer;
  }
  return out;
}

/**
 * 계약 계수 대상 콜백만의 전달 순서(인터프리터 trace 와 비교용).
 * 텍스트는 `종류:글리프 수`(gid −1 보조 글리프 제외, fill 다음 같은 포인터 stroke 는 fill+stroke),
 * 칠하기는 `P`. beginMask~endMask 구간은 빼고, beginTile 은 1(캐시됨)을 돌려준다.
 */
export function deliveryTrace(page: mupdf.Page, flags = false): string[] {
  const out: string[] = [];
  // flags: first-arrival 판정(테스트 헬퍼 규칙)으로 글리프마다 N(새 글리프)·R(재전송)을 붙인다.
  let known = new Set<string>();
  const held: mupdf.Text[] = [];
  let mask = 0;
  let last: { pointer: number; kind: string; index: number } | null = null;
  const kinds: Record<string, string> = {
    fillText: 'fill',
    strokeText: 'stroke',
    clipText: 'clip',
    clipStrokeText: 'clip-stroke',
    ignoreText: 'ignore',
  };
  const text = (name: string) => (t: mupdf.Text) => {
    if (mask > 0) return;
    held.push(t);
    let n = 0;
    let f = '';
    const kind = kinds[name]!;
    const samePointer = last !== null && last.pointer === t.pointer;
    let resend = false;
    t.walk({
      showGlyph: (font, m, gid) => {
        if (gid < 0) return;
        n++;
        const key = `${font.pointer}:${gid}:${m.join(',')}`;
        if (samePointer) f += 'R';
        else if (kind !== 'fill' && kind !== 'stroke' && known.has(key)) {
          f += 'R';
          resend = true;
        } else {
          f += 'N';
          if (kind === 'fill' || kind === 'stroke') known.add(key);
        }
      },
    });
    if (resend) known = new Set();
    const tag = flags ? `:${f}` : '';
    if (
      kind === 'stroke' &&
      last &&
      last.pointer === t.pointer &&
      last.kind === 'fill' &&
      last.index === out.length - 1
    ) {
      // 직전 fill 항목의 플래그를 그대로 쓴다(같은 객체의 두 번째 콜백).
      out[out.length - 1] = out[out.length - 1]!.replace(/^fill:/, 'fill+stroke:');
      last = null;
      return;
    }
    out.push(`${kind}:${n}${tag}`);
    last = { pointer: t.pointer, kind, index: out.length - 1 };
  };
  const paint = () => {
    if (mask > 0) return;
    out.push('P');
  };
  const device = new mupdf.Device({
    fillText: text('fillText'),
    strokeText: text('strokeText'),
    clipText: text('clipText'),
    clipStrokeText: text('clipStrokeText'),
    ignoreText: text('ignoreText'),
    fillPath: paint,
    strokePath: paint,
    clipPath: paint,
    clipStrokePath: paint,
    fillShade: paint,
    fillImage: paint,
    fillImageMask: paint,
    clipImageMask: paint,
    beginMask: () => void mask++,
    endMask: () => void mask--,
    beginTile: () => 1,
  });
  page.runPageContents(device, mupdf.Matrix.identity);
  device.close();
  return out;
}
