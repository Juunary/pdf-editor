/**
 * Type3 glyph preparation (emulates MuPDF 1.28 fz_prepare_t3_glyph and pdf_load_type3_font).
 *
 * When loading a Type3 font, MuPDF computes device flags for each glyph procedure. The initial flags have fill/stroke color and line state
 * (cap, join, miter, width, dash) as "undefined". d0 turns on COLOR, d1 turns on MASK and clears color-undefined. Color operations
 * clear the corresponding color-undefined, and w, j, J, M, d (and LW, LJ, LC, ML, D in gs) clear the corresponding line-state-undefined. If painting uses an undefined state
 * (pdf_show_path) it becomes UNCACHEABLE, and when that glyph is shown the glyph procedure is executed directly on the device and the text is then
 * sent invisible (Tr 3) (pdf_show_char render_direct). The interpreter uses these flags to decide on direct execution.
 */
import type * as mupdf from 'mupdf';
import type { Matrix } from '@pdf-editor/shared-types';
import { parseContentOpsLenient, type Token } from './content-stream.js';
import { MAC_ROMAN_ENCODING, STANDARD_ENCODING, WIN_ANSI_ENCODING } from './glyph-names.js';
import { readStreamBytes } from './mupdf-util.js';

export const T3_COLOR = 1 << 0;
export const T3_MASK = 1 << 1;
export const T3_UNCACHEABLE = 1 << 2;
const FILLCOLOR_U = 1 << 3;
const STROKECOLOR_U = 1 << 4;
const CAPS_U = 1 << 5;
const LINEJOIN_U = 1 << 6;
const MITERLIMIT_U = 1 << 7;
const LINEWIDTH_U = 1 << 8;
const DASH_U = 1 << 9;

export interface Type3Glyph {
  /** Decoded glyph procedure. */
  bytes: Uint8Array;
  flags: number;
}

export interface Type3Font {
  /** MuPDF t3matrix (/FontMatrix, identity if absent). */
  matrix: Matrix;
  /** Glyph procedure resources (the font's /Resources, or if absent the resources of the content that loaded the font). */
  resources: mupdf.PDFObject | null;
  /** Code (= MuPDF gid) → glyph. undefined if there is no procedure. */
  glyphs: Map<number, Type3Glyph>;
}

const at = (o: mupdf.PDFObject, k: string) => (o.isNull() ? o : o.get(k));

function nums(tokens: readonly Token[]): number[] {
  return tokens.filter((t) => t.kind === 'number').map((t) => t.value as number);
}

/** Device flags of a glyph procedure (result of running fz_prepare_t3_glyph on the list device). */
export function type3GlyphFlags(bytes: Uint8Array, resources: mupdf.PDFObject | null): number {
  let flags =
    FILLCOLOR_U | STROKECOLOR_U | CAPS_U | LINEJOIN_U | MITERLIMIT_U | LINEWIDTH_U | DASH_U;
  let lineJoin = 0;
  let dashLen = 0;
  const stack: [number, number][] = [];
  const paint = (dofill: boolean, dostroke: boolean) => {
    if (dostroke) {
      if (flags & (STROKECOLOR_U | LINEJOIN_U | LINEWIDTH_U | DASH_U)) flags |= T3_UNCACHEABLE;
      else if (dashLen !== 0 && flags & CAPS_U) flags |= T3_UNCACHEABLE;
      else if (lineJoin === 0 && flags & MITERLIMIT_U) flags |= T3_UNCACHEABLE;
    }
    if (dofill && flags & FILLCOLOR_U) flags |= T3_UNCACHEABLE;
  };
  const { ops } = parseContentOpsLenient(bytes);
  for (const op of ops) {
    switch (op.op) {
      case 'd0':
        flags |= T3_COLOR;
        break;
      case 'd1':
        flags |= T3_MASK;
        flags &= ~(FILLCOLOR_U | STROKECOLOR_U);
        break;
      case 'CS':
      case 'SC':
      case 'SCN':
      case 'G':
      case 'RG':
      case 'K':
        flags &= ~STROKECOLOR_U;
        break;
      case 'cs':
      case 'sc':
      case 'scn':
      case 'g':
      case 'rg':
      case 'k':
        flags &= ~FILLCOLOR_U;
        break;
      case 'w':
        flags &= ~LINEWIDTH_U;
        break;
      case 'j':
        flags &= ~LINEJOIN_U;
        lineJoin = Math.trunc(nums(op.operands)[0] ?? 0);
        break;
      case 'J':
        flags &= ~CAPS_U;
        break;
      case 'M':
        flags &= ~MITERLIMIT_U;
        break;
      case 'd':
        flags &= ~DASH_U;
        dashLen = op.operands.filter((t) => t.kind === 'number').length - 1;
        if (dashLen < 0) dashLen = 0;
        break;
      case 'gs': {
        const name = op.operands.find((t) => t.kind === 'name')?.value as string | undefined;
        const g = name && resources ? at(at(resources, 'ExtGState'), name) : null;
        if (!g || !g.isDictionary()) break;
        if (!g.get('LW').isNull()) flags &= ~LINEWIDTH_U;
        if (!g.get('LC').isNull()) flags &= ~CAPS_U;
        const lj = g.get('LJ');
        if (!lj.isNull()) {
          flags &= ~LINEJOIN_U;
          if (lj.isNumber()) lineJoin = Math.trunc(lj.asNumber());
        }
        if (!g.get('ML').isNull()) flags &= ~MITERLIMIT_U;
        const dash = g.get('D');
        if (!dash.isNull()) {
          flags &= ~DASH_U;
          const arr = dash.isArray() ? dash.get(0) : null;
          dashLen = arr && arr.isArray() ? arr.length : 0;
        }
        break;
      }
      case 'q':
        stack.push([lineJoin, dashLen]);
        break;
      case 'Q': {
        const s = stack.pop();
        if (s) [lineJoin, dashLen] = s;
        break;
      }
      case 'S':
      case 's':
        paint(false, true);
        break;
      case 'f':
      case 'F':
      case 'f*':
        paint(true, false);
        break;
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
        paint(true, true);
        break;
      default:
        break;
    }
  }
  return flags & (T3_COLOR | T3_MASK | T3_UNCACHEABLE);
}

function encodingNames(dict: mupdf.PDFObject): (string | null)[] {
  const names: (string | null)[] = new Array<string | null>(256).fill(null);
  const enc = dict.get('Encoding');
  if (!enc.isDictionary()) return names;
  const base = enc.get('BaseEncoding');
  const table = base.isName()
    ? base.asName() === 'StandardEncoding'
      ? STANDARD_ENCODING
      : base.asName() === 'WinAnsiEncoding'
        ? WIN_ANSI_ENCODING
        : base.asName() === 'MacRomanEncoding'
          ? MAC_ROMAN_ENCODING
          : null
    : null;
  if (table) for (let i = 0; i < 256; i++) names[i] = table[i] ?? null;
  const diff = enc.get('Differences');
  if (diff.isArray()) {
    let k = 0;
    for (let i = 0; i < diff.length; i++) {
      const item = diff.get(i);
      if (item.isNumber()) k = Math.trunc(item.asNumber());
      else if (item.isName() && k >= 0 && k < 256) names[k++] = item.asName();
    }
  }
  return names;
}

/** Type3 font dictionary → glyph preparation result. fallbackResources = inner resources of the content that loaded the font. */
export function loadType3(
  dict: mupdf.PDFObject,
  fallbackResources: mupdf.PDFObject | null,
): Type3Font {
  const fm = dict.get('FontMatrix');
  const matrix: Matrix = fm.isArray()
    ? ([0, 1, 2, 3, 4, 5].map((i) => {
        const v = fm.get(i);
        return v.isNumber() ? v.asNumber() : 0;
      }) as Matrix)
    : [1, 0, 0, 1, 0, 0];
  const own = dict.get('Resources');
  const resources = own.isNull() ? fallbackResources : own;
  const procs = dict.get('CharProcs');
  const glyphs = new Map<number, Type3Glyph>();
  encodingNames(dict).forEach((name, code) => {
    if (!name) return;
    const s = at(procs, name);
    if (!s.isStream()) return;
    const bytes = readStreamBytes(s);
    glyphs.set(code, { bytes, flags: type3GlyphFlags(bytes, resources) });
  });
  return { matrix, resources, glyphs };
}
