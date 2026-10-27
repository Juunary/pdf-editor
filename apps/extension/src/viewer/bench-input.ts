/**
 * Manual input tools for the measurement page (pure functions). `bench.ts` handles the DOM wiring.
 *
 * - Tab memory: Chrome Task Manager (Shift+Esc) "메모리 사용 공간" (Memory footprint) is displayed in K (1 K = 1024 byte) units, e.g. `272,940K`. The input is
 *   taken as the displayed number, converted to MiB, and the original text and unit are kept in the result JSON. Suspicious values trigger a warning and a second confirmation.
 * - Pages designated for page classification: a server run passes `judgePages` from `fixtures/bench/manifest.json`, but a manual run only picks a file, so the same
 *   values are looked up by file name (id) (a test checks that they match the manifest).
 */

export type TabUnit = 'K' | 'MiB';

export interface ParsedTabInput {
  /** Value converted to MiB. null if it could not be read. */
  mib: number | null;
  raw: string;
  /** Unit applied. The unit letters in the input (K, KB, MB, MiB, GB, GiB) if present, otherwise the selected unit. GB is recorded as MiB. */
  unit: TabUnit;
}

const SUFFIX = /^(.*?)(k|kb|kib|m|mb|mib|g|gb|gib)$/i;

/** Reads a Task Manager value (e.g. `272,940K`, `272940`, `1.2 GB`) as MiB. Commas and spaces are ignored. */
export function parseTabInput(raw: string, selected: TabUnit): ParsedTabInput {
  const text = raw.replace(/[\s,_]/g, '');
  const m = SUFFIX.exec(text);
  const numText = m ? m[1]! : text;
  const suffix = m ? m[2]!.toLowerCase() : null;
  const value = numText === '' ? NaN : Number(numText);
  if (!Number.isFinite(value) || value <= 0) return { mib: null, raw, unit: selected };
  if (suffix === null) {
    return { mib: selected === 'K' ? value / 1024 : value, raw, unit: selected };
  }
  if (suffix.startsWith('k')) return { mib: value / 1024, raw, unit: 'K' };
  if (suffix.startsWith('g')) return { mib: value * 1024, raw, unit: 'MiB' };
  return { mib: value, raw, unit: 'MiB' };
}

/** The viewer tab cannot be smaller than this (for a wrongly chosen unit). */
export const TAB_MIN_MIB = 10;
/** Asks for a magnitude check when the value is at least this many times (or at most 1/this) the previous value. */
export const TAB_JUMP_FACTOR = 5;

/**
 * Tab memory input warnings. `previous` is the value received earlier for the same document (MiB, in the order checkpoint, right after end), and `ramMiB` is the RAM reported by the browser
 * (`navigator.deviceMemory` × 1024, null if unknown). Warnings do not change the classification; they are used only for user confirmation and the result record.
 */
export function tabInputWarnings(
  mib: number,
  previous: readonly number[],
  ramMiB: number | null,
): string[] {
  const out: string[] = [];
  const prev = previous.at(-1);
  if (previous.length >= 2 && previous.every((v) => v === mib)) {
    out.push('세 시점 값이 모두 같습니다(새로 읽은 값인지 확인)');
  } else if (prev !== undefined && prev === mib) {
    out.push('직전 입력과 같은 값입니다(새로 읽은 값인지 확인)');
  }
  if (ramMiB !== null && mib > ramMiB) out.push(`RAM(${Math.round(ramMiB)} MiB)보다 큽니다`);
  if (prev !== undefined && prev > 0 && mib >= prev * TAB_JUMP_FACTOR) {
    out.push(`직전 값의 ${TAB_JUMP_FACTOR}배 이상입니다(자릿수 확인)`);
  }
  if (prev !== undefined && mib > 0 && mib * TAB_JUMP_FACTOR <= prev) {
    out.push(`직전 값의 1/${TAB_JUMP_FACTOR} 이하입니다(자릿수 확인)`);
  }
  if (mib < TAB_MIN_MIB) out.push(`${TAB_MIN_MIB} MiB 미만입니다(단위 확인)`);
  return out;
}

/**
 * Page(s) that must be included in page classification (0-based). Must match `judgePages` in `fixtures/bench/manifest.json` (tested).
 * kogl-mods-cpi-202609 3 = page 4 (the page with the largest path).
 */
export const KNOWN_JUDGE_PAGES: Readonly<Record<string, readonly number[]>> = {
  'kogl-mods-cpi-202609': [3],
};

/** Document id of the selected file name (the name without the `.pdf` extension) and its designated pages. */
export function benchDocOfFile(name: string): { id: string; judgePages?: number[] } {
  const id = name.replace(/\.pdf$/i, '');
  const pages = KNOWN_JUDGE_PAGES[id];
  return pages ? { id, judgePages: [...pages] } : { id };
}
