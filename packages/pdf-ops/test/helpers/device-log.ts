/**
 * Test only: records the `runPageContents` (identity matrix) Device callbacks in order. Not exported from the package.
 * Text callbacks keep the string of concatenated glyph Unicode and the text object pointer.
 */
import * as mupdf from 'mupdf';
import { releaseBorrowedShade } from '../../src/mupdf-util.js';
import {
  FirstArrivalJudge,
  glyphKey,
  type JudgeOptions,
  type TextCallbackKind,
} from './first-arrival.js';

export interface DeviceEvent {
  kind: string;
  /** Text callbacks only: concatenated glyph Unicode. */
  text?: string;
  /** Text callbacks only: fz_text pointer. */
  pointer?: number;
  /** Text callbacks only: [gid, 6 trm values] per glyph. */
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
  // Hold on to the Text received as a callback argument so that the pointer is not reused.
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
    fillShade: (shade) => {
      releaseBorrowedShade(shade);
      events.push({ kind: 'fillShade' });
    },
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
  // FinalizationRegistry cleanup does not run in a synchronous loop, so release directly (callback closures and text references of the device table).
  device.destroy();
  for (const t of held) t.destroy();
  return events;
}

/** Short notation for comparison: text is "fill:Ab", consecutive same pointers "stroke=:Ab", anything else is the callback name. */
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
 * Delivery sequence of only the callbacks that the contract counts (for comparison with the interpreter trace).
 * Text is `kind:glyph count` (excluding gid -1 auxiliary glyphs; a stroke with the same pointer after fill is fill+stroke),
 * paints are `P`. The beginMask~endMask section is omitted, and beginTile returns 1 (cached).
 */
export function deliveryTrace(
  page: mupdf.Page,
  flags = false,
  judgeOptions: JudgeOptions = {},
): string[] {
  const out: string[] = [];
  // flags: attach N (new glyph) / R (re-send) to each glyph by the contract 3.1 core classification (all R if the callback is skipped).
  const judge = new FirstArrivalJudge(judgeOptions);
  const held: mupdf.Text[] = [];
  let mask = 0;
  let last: { pointer: number; kind: string; index: number } | null = null;
  const kinds: Record<string, TextCallbackKind> = {
    fillText: 'fill',
    strokeText: 'stroke',
    clipText: 'clip',
    clipStrokeText: 'clip-stroke',
    ignoreText: 'ignore',
  };
  const text =
    (name: string) =>
    (t: mupdf.Text, ...rest: unknown[]) => {
      if (mask > 0) return;
      held.push(t);
      const ctm = rest.find((r) => Array.isArray(r) && r.length === 6) as number[];
      const kind = kinds[name]!;
      const keys: string[] = [];
      t.walk({
        showGlyph: (font, m, gid) =>
          void (gid >= 0 && keys.push(glyphKey(font.pointer, gid, m, ctm))),
      });
      const decisions = judge.judge(kind, t.pointer, keys);
      const f = decisions
        ? decisions.map((d) => (d ? 'N' : 'R')).join('')
        : 'R'.repeat(keys.length);
      const n = keys.length;
      if (
        kind === 'stroke' &&
        last &&
        last.pointer === t.pointer &&
        last.kind === 'fill' &&
        last.index === out.length - 1
      ) {
        // Use the flag of the previous fill entry as is (the second callback of the same object).
        out[out.length - 1] = out[out.length - 1]!.replace(/^fill:/, 'fill+stroke:');
        last = null;
        return;
      }
      out.push(`${kind}:${n}${flags ? `:${f}` : ''}`);
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
    fillShade: (shade) => {
      releaseBorrowedShade(shade);
      paint();
    },
    fillImage: paint,
    fillImageMask: paint,
    clipImageMask: paint,
    beginMask: () => void mask++,
    endMask: () => void mask--,
    beginTile: () => 1,
  });
  page.runPageContents(device, mupdf.Matrix.identity);
  device.close();
  // FinalizationRegistry cleanup does not run in a synchronous loop, so release directly (callback closures and text references of the device table).
  device.destroy();
  for (const t of held) t.destroy();
  return out;
}
