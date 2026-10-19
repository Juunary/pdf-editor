// 계약 3절 검증 전제 V1·V3 의 근거(MuPDF 1.28.1 Device 콜백 관측). 계약이 바뀌어도 이 관측은 유지된다.
import '../src/wasm-module.js';
import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';

interface TextEvent {
  kind: 'fillText' | 'strokeText' | 'clipText' | 'clipStrokeText' | 'ignoreText';
  /** fz_text 포인터. 콜백마다 새 JS 래퍼를 만들지만 포인터는 C 객체 기준이다. */
  pointer: number;
  /** 글리프 유니코드를 이어 붙인 문자열. */
  glyphs: string;
}

type Event = TextEvent | { kind: 'other'; name: string };

/** 합성 1쪽 PDF(Helvetica, F1)의 /Contents 를 `runPageContents` 로 실행한 콜백 순서. */
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
  // 콜백 사이에 포인터가 재사용되지 않도록 래퍼를 끝까지 잡아 둔다.
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

describe('V1: Form XObject 재귀는 콘텐츠 실행 순서로 온다', () => {
  it('Do 위치에서 Form 안 텍스트가 오고, BBox 클립(clipPath·popClip)이 감싼다', () => {
    const events = trace(
      'BT /F1 12 Tf 10 100 Td (A) Tj ET q 1 0 0 1 50 50 cm /Fm1 Do Q BT /F1 12 Tf 10 20 Td (Z) Tj ET',
      'BT /F1 10 Tf 5 5 Td (XY) Tj ET',
    );
    expect(kinds(events)).toEqual(['fillText', 'clipPath', 'fillText', 'popClip', 'fillText']);
    expect(textEvents(events).map((e) => e.glyphs)).toEqual(['A', 'XY', 'Z']);
  });
});

describe('V3: 텍스트 렌더 모드(Tr)별 콜백', () => {
  const run = (tr: number, body = '(AB) Tj') => trace(`BT /F1 12 Tf ${tr} Tr 10 100 Td ${body} ET`);

  it('Tr 0·1·3 은 콜백 1개(fillText·strokeText·ignoreText)', () => {
    expect(kinds(run(0))).toEqual(['fillText']);
    expect(kinds(run(1))).toEqual(['strokeText']);
    expect(kinds(run(3))).toEqual(['ignoreText']);
  });

  it('Tr 2: fillText → strokeText 가 같은 텍스트 객체(포인터 동일)', () => {
    const [fill, stroke] = textEvents(run(2));
    expect([fill?.kind, stroke?.kind]).toEqual(['fillText', 'strokeText']);
    expect(stroke?.pointer).toBe(fill?.pointer);
  });

  it('Tr 4·5·6: clipText 는 fill/stroke 와 다른 텍스트 객체이고 같은 글리프를 다시 보낸다', () => {
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
      // 계약 3절 "포인터 동일" 판정으로는 이 clipText 를 중복으로 알 수 없다.
      expect(clip.pointer, `Tr ${tr}`).not.toBe(events[0]!.pointer);
    }
    const tr6 = textEvents(run(6));
    expect(tr6.map((e) => e.kind)).toEqual(['fillText', 'strokeText', 'clipText']);
    expect(tr6[1]!.pointer).toBe(tr6[0]!.pointer);
  });

  it('Tr 7: clipText 만 온다(글리프의 유일한 콜백)', () => {
    const events = run(7);
    expect(kinds(events)).toEqual(['clipText', 'popClip']);
    expect(textEvents(events)[0]!.glyphs).toBe('AB');
  });

  it('clipText 는 BT…ET 의 Tr 4–7 글리프를 모아 한 객체로 보낸다(fill 이 여러 번이어도)', () => {
    const events = textEvents(run(4, '1 0 0 rg (AB) Tj 0 1 0 rg (CD) Tj'));
    expect(events.map((e) => [e.kind, e.glyphs])).toEqual([
      ['fillText', 'AB'],
      ['fillText', 'CD'],
      ['clipText', 'ABCD'],
    ]);
  });

  it('Tr 4 와 Tr 7 이 한 BT 에 섞이면 Tr 7 글리프는 clipText 에만 있다', () => {
    const events = textEvents(run(4, '(AB) Tj 7 Tr (CD) Tj'));
    expect(events.map((e) => [e.kind, e.glyphs])).toEqual([
      ['fillText', 'AB'],
      ['clipText', 'ABCD'],
    ]);
  });
});

describe('V3: 텍스트 객체 포인터 비교의 전제', () => {
  /** 색을 바꿔 flush 를 나눈 서로 다른 텍스트 객체 n 개를 받고, 직전 콜백과 포인터가 같았던 횟수를 센다. */
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

  it('래퍼를 잡고 있으면 서로 다른 텍스트 객체의 포인터는 겹치지 않는다', () => {
    expect(samePointerCount(100, false)).toBe(0);
  });

  it('래퍼를 콜백 직후 destroy 하면 해제된 주소가 다음 텍스트 객체에 재사용된다', () => {
    // 실측 99/100(2026-10-19, Node). 포인터 동일 판정은 직전 래퍼를 다음 콜백 비교가 끝날 때까지 유지해야 한다.
    expect(samePointerCount(100, true)).toBeGreaterThan(50);
  });
});
