/**
 * Test only: implements the contract 3.1 core classification ("first-arrival counting", fixed 2026-10-19, amendment 4 key rule, amendment 6 step 1) as is.
 *
 * 0) gid -1 auxiliary glyphs are not targets (the caller filters them).
 * 1) A text callback with the same pointer as the previous text callback is skipped entirely regardless of kind (amendment 6).
 * 2) fillText, strokeText: counted per glyph. The key (font, gid, 6 trm values, 6 callback ctm values) is put into the counted list (entry list).
 * 3) clipText, clipStrokeText, ignoreText: if the key equals an unconsumed entry of the counted list, one entry is consumed and not counted.
 *    Otherwise it is counted. Glyphs newly counted in clipText and clipStrokeText are put into the counted list (after callback processing).
 * 4) When a callback that consumed one or more ends, the counted list is emptied.
 * 5) Callbacks between beginMask and endMask are not called (the caller's responsibility).
 */
export type TextCallbackKind = 'fill' | 'stroke' | 'clip' | 'clip-stroke' | 'ignore';

export interface JudgeOptions {
  /** For comparison: step 1 of contract amendments 2-5 (skips only fillText and strokeText). Used only to reproduce the regression of the pre-amendment-6 rule. */
  step1FillStrokeOnly?: boolean;
}

export class FirstArrivalJudge {
  private readonly counted = new Map<string, number>();
  private lastPointer: number | null = null;

  constructor(private readonly options: JudgeOptions = {}) {}

  /** Per-glyph classification of one callback. null = the whole callback is skipped (step 1). true = new glyph (counted), false = re-send. */
  judge(kind: TextCallbackKind, pointer: number, keys: readonly string[]): boolean[] | null {
    const same = pointer === this.lastPointer;
    this.lastPointer = pointer;
    if (same && (!this.options.step1FillStrokeOnly || kind === 'fill' || kind === 'stroke')) {
      return null;
    }
    if (kind === 'fill' || kind === 'stroke') {
      for (const k of keys) this.counted.set(k, (this.counted.get(k) ?? 0) + 1);
      return keys.map(() => true);
    }
    let consumed = 0;
    const added: string[] = [];
    const out = keys.map((k) => {
      const n = this.counted.get(k) ?? 0;
      if (n > 0) {
        this.counted.set(k, n - 1);
        consumed++;
        return false;
      }
      if (kind !== 'ignore') added.push(k);
      return true;
    });
    for (const k of added) this.counted.set(k, (this.counted.get(k) ?? 0) + 1);
    if (consumed > 0) this.counted.clear();
    return out;
  }
}

export const glyphKey = (
  fontPointer: number,
  gid: number,
  trm: readonly number[],
  ctm: readonly number[],
) => `${fontPointer}:${gid}:${trm.join(',')}:${ctm.join(',')}`;
