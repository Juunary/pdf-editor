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
