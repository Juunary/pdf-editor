/**
 * 측정 페이지 수동 입력 도구(순수 함수). DOM 연결은 `bench.ts` 가 맡는다.
 *
 * - 탭 메모리: Chrome 작업 관리자(Shift+Esc) "메모리 사용 공간" 은 `272,940K` 처럼 K(1 K = 1024 byte) 단위로 보인다. 입력은
 *   보이는 숫자 그대로 받아 MiB 로 바꾸고, 원문·단위를 결과 JSON 에 남긴다. 의심스러운 값은 경고하고 한 번 더 확인받는다.
 * - 쪽 판정 지정 쪽: 서버 실행은 `fixtures/bench/manifest.json` 의 `judgePages` 를 넘기지만 수동 실행은 파일만 고르므로, 같은
 *   값을 파일 이름(id)으로 찾는다(시험이 manifest 와 같은지 확인한다).
 */

export type TabUnit = 'K' | 'MiB';

export interface ParsedTabInput {
  /** MiB 로 바꾼 값. 읽지 못했으면 null. */
  mib: number | null;
  raw: string;
  /** 적용한 단위. 입력에 단위 글자(K·KB·MB·MiB·GB·GiB)가 있으면 그것, 없으면 고른 단위. GB 는 MiB 로 기록한다. */
  unit: TabUnit;
}

const SUFFIX = /^(.*?)(k|kb|kib|m|mb|mib|g|gb|gib)$/i;

/** 작업 관리자 값(예: `272,940K`, `272940`, `1.2 GB`)을 MiB 로 읽는다. 쉼표·공백은 무시한다. */
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

/** 뷰어 탭이 이보다 작을 수 없다(단위를 잘못 골랐을 때). */
export const TAB_MIN_MIB = 10;
/** 직전 값 대비 이 배 이상(또는 이 분의 1 이하)이면 자릿수 확인을 묻는다. */
export const TAB_JUMP_FACTOR = 5;

/**
 * 탭 메모리 입력 경고. `previous` 는 같은 문서에서 앞서 받은 값(MiB, 기준점·종료 직후 순), `ramMiB` 는 브라우저가 알려 준
 * RAM(`navigator.deviceMemory` × 1024, 모르면 null). 경고는 판정을 바꾸지 않고 사용자 확인과 결과 기록에만 쓴다.
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
 * 쪽 판정에 꼭 넣을 쪽(0부터). `fixtures/bench/manifest.json` 의 `judgePages` 와 같아야 한다(시험).
 * kogl-mods-cpi-202609 3 = 4쪽(최대 패스 쪽).
 */
export const KNOWN_JUDGE_PAGES: Readonly<Record<string, readonly number[]>> = {
  'kogl-mods-cpi-202609': [3],
};

/** 고른 파일 이름의 문서 id(확장자 `.pdf` 를 뺀 이름)와 지정 쪽. */
export function benchDocOfFile(name: string): { id: string; judgePages?: number[] } {
  const id = name.replace(/\.pdf$/i, '');
  const pages = KNOWN_JUDGE_PAGES[id];
  return pages ? { id, judgePages: [...pages] } : { id };
}
