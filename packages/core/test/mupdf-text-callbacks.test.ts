// Evidence for the verification premises V1 and V3 of contract section 3 (observation of MuPDF 1.28.1 Device callbacks). This observation holds even if the contract changes.
import '../src/wasm-module.js';
import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';

interface TextEvent {
  kind: 'fillText' | 'strokeText' | 'clipText' | 'clipStrokeText' | 'ignoreText';
  /** fz_text pointer. Each callback creates a new JS wrapper, but the pointer refers to the C object. */
  pointer: number;
  /** String concatenating the glyph Unicode values. */
  glyphs: string;
}

type Event = TextEvent | { kind: 'other'; name: string };

/** Callback order from running the /Contents of a synthetic 1-page PDF (Helvetica, F1) with `runPageContents`. */
function trace(content: string, form?: string): Event[] {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  const resources: Record<string, unknown> = { Font: { F1: font } };
  if (form) {
    resources.XObject = {
      Fm1: doc.addStream(form, {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 100, 100],
        Resources: { Font: { F1: font } },
      }),
    };
  }
  doc.insertPage(-1, doc.addPage([0, 0, 300, 200], 0, resources, content));
  const page = doc.loadPage(0);
  const events: Event[] = [];
  // Hold the wrappers until the end so that pointers are not reused between callbacks.
  const held: mupdf.Text[] = [];
  const text = (kind: TextEvent['kind']) => (t: mupdf.Text) => {
    held.push(t);
    let glyphs = '';
    t.walk({
      showGlyph(_font, _trm, _gid, unicode) {
        glyphs += String.fromCodePoint(unicode);
      },
    });
    events.push({ kind, pointer: t.pointer as unknown as number, glyphs });
  };
  const other = (name: string) => () => {
    events.push({ kind: 'other', name });
  };
  const device = new mupdf.Device({
    fillText: text('fillText'),
    strokeText: text('strokeText'),
    clipText: text('clipText'),
    clipStrokeText: text('clipStrokeText'),
    ignoreText: text('ignoreText'),
    fillPath: other('fillPath'),
    strokePath: other('strokePath'),
    clipPath: other('clipPath'),
    popClip: other('popClip'),
  });
  try {
    page.runPageContents(device, mupdf.Matrix.identity);
    device.close();
  } finally {
    device.destroy();
    for (const t of held) t.destroy();
    page.destroy();
  }
  return events;
}

const kinds = (events: Event[]) => events.map((e) => (e.kind === 'other' ? e.name : e.kind));
const textEvents = (events: Event[]) => events.filter((e): e is TextEvent => e.kind !== 'other');

describe('V1: Form XObject recursion arrives in content execution order', () => {
  it('text inside the Form arrives at the Do position, wrapped by the BBox clip (clipPath, popClip)', () => {
    const events = trace(
      'BT /F1 12 Tf 10 100 Td (A) Tj ET q 1 0 0 1 50 50 cm /Fm1 Do Q BT /F1 12 Tf 10 20 Td (Z) Tj ET',
      'BT /F1 10 Tf 5 5 Td (XY) Tj ET',
    );
    expect(kinds(events)).toEqual(['fillText', 'clipPath', 'fillText', 'popClip', 'fillText']);
    expect(textEvents(events).map((e) => e.glyphs)).toEqual(['A', 'XY', 'Z']);
  });
});

describe('V3: callbacks per text render mode (Tr)', () => {
  const run = (tr: number, body = '(AB) Tj') => trace(`BT /F1 12 Tf ${tr} Tr 10 100 Td ${body} ET`);

  it('Tr 0, 1 and 3 give one callback (fillText, strokeText, ignoreText)', () => {
    expect(kinds(run(0))).toEqual(['fillText']);
    expect(kinds(run(1))).toEqual(['strokeText']);
    expect(kinds(run(3))).toEqual(['ignoreText']);
  });

  it('Tr 2: fillText → strokeText use the same text object (same pointer)', () => {
    const [fill, stroke] = textEvents(run(2));
    expect([fill?.kind, stroke?.kind]).toEqual(['fillText', 'strokeText']);
    expect(stroke?.pointer).toBe(fill?.pointer);
  });

  it('Tr 4, 5 and 6: clipText is a different text object from fill/stroke and sends the same glyphs again', () => {
    for (const [tr, first] of [
      [4, 'fillText'],
      [5, 'strokeText'],
      [6, 'fillText'],
    ] as const) {
      const events = textEvents(run(tr));
      const clip = events.at(-1)!;
      expect(clip.kind, `Tr ${tr}`).toBe('clipText');
      expect(events[0]!.kind, `Tr ${tr}`).toBe(first);
      expect(clip.glyphs, `Tr ${tr}`).toBe(events[0]!.glyphs);
      // The "same pointer" check of contract section 3 cannot identify this clipText as a duplicate.
      expect(clip.pointer, `Tr ${tr}`).not.toBe(events[0]!.pointer);
    }
    const tr6 = textEvents(run(6));
    expect(tr6.map((e) => e.kind)).toEqual(['fillText', 'strokeText', 'clipText']);
    expect(tr6[1]!.pointer).toBe(tr6[0]!.pointer);
  });

  it('Tr 7: only clipText arrives (the only callback for the glyphs)', () => {
    const events = run(7);
    expect(kinds(events)).toEqual(['clipText', 'popClip']);
    expect(textEvents(events)[0]!.glyphs).toBe('AB');
  });

  it('clipText gathers the Tr 4–7 glyphs of a BT…ET and sends them as one object (even if there are several fills)', () => {
    const events = textEvents(run(4, '1 0 0 rg (AB) Tj 0 1 0 rg (CD) Tj'));
    expect(events.map((e) => [e.kind, e.glyphs])).toEqual([
      ['fillText', 'AB'],
      ['fillText', 'CD'],
      ['clipText', 'ABCD'],
    ]);
  });

  it('when Tr 4 and Tr 7 are mixed in one BT, the Tr 7 glyphs exist only in clipText', () => {
    const events = textEvents(run(4, '(AB) Tj 7 Tr (CD) Tj'));
    expect(events.map((e) => [e.kind, e.glyphs])).toEqual([
      ['fillText', 'AB'],
      ['clipText', 'ABCD'],
    ]);
  });
});

describe('V3: premise of the text object pointer comparison', () => {
  /** Receives n distinct text objects split by changing colors to force flushes, and counts how many times the pointer equaled the previous callback's. */
  function samePointerCount(n: number, destroyWrapperImmediately: boolean): number {
    const doc = new mupdf.PDFDocument();
    const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
    let content = 'BT /F1 12 Tf 10 100 Td ';
    for (let i = 0; i < n; i++) content += `${(i % 2) * 0.5} 0 0 rg (A) Tj `;
    doc.insertPage(-1, doc.addPage([0, 0, 300, 200], 0, { Font: { F1: font } }, content + 'ET'));
    const page = doc.loadPage(0);
    const held: mupdf.Text[] = [];
    let previous: unknown = null;
    let same = 0;
    const device = new mupdf.Device({
      fillText(t) {
        if (previous === t.pointer) same++;
        previous = t.pointer;
        if (destroyWrapperImmediately) t.destroy();
        else held.push(t);
      },
    });
    page.runPageContents(device, mupdf.Matrix.identity);
    device.destroy();
    for (const t of held) t.destroy();
    page.destroy();
    return same;
  }

  it('while the wrappers are held, the pointers of distinct text objects do not collide', () => {
    expect(samePointerCount(100, false)).toBe(0);
  });

  it('when a wrapper is destroyed right after the callback, the freed address is reused for the next text object', () => {
    // Measured 99/100 (2026-10-19, Node). The same-pointer check must keep the previous wrapper alive until the next callback comparison finishes.
    expect(samePointerCount(100, true)).toBeGreaterThan(50);
  });
});
