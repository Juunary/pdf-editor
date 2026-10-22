import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  KNOWN_JUDGE_PAGES,
  benchDocOfFile,
  parseTabInput,
  tabInputWarnings,
} from '../src/viewer/bench-input.js';

describe('bench-input 탭 메모리 입력', () => {
  it('작업 관리자 K 값을 MiB 로 바꾼다(쉼표·접미사 허용)', () => {
    expect(parseTabInput('272940', 'K')).toEqual({ mib: 272940 / 1024, raw: '272940', unit: 'K' });
    expect(parseTabInput('272,940K', 'MiB')).toMatchObject({ mib: 272940 / 1024, unit: 'K' });
    expect(parseTabInput(' 983.7 ', 'MiB')).toMatchObject({ mib: 983.7, unit: 'MiB' });
    expect(parseTabInput('1.5 GB', 'K')).toMatchObject({ mib: 1536, unit: 'MiB' });
    expect(parseTabInput('266 MB', 'K')).toMatchObject({ mib: 266, unit: 'MiB' });
  });

  it('숫자가 아니거나 0 이하면 null', () => {
    expect(parseTabInput('', 'K').mib).toBeNull();
    expect(parseTabInput('abc', 'K').mib).toBeNull();
    expect(parseTabInput('0', 'MiB').mib).toBeNull();
    expect(parseTabInput('-5', 'MiB').mib).toBeNull();
  });

  it('Windows 1차 입력(세 시점 42420 K)은 같은 값 경고, 세 번째는 모두 같음 경고', () => {
    const v = 42420 / 1024;
    expect(tabInputWarnings(v, [], 32768)).toEqual([]);
    expect(tabInputWarnings(v, [v], 32768)).toEqual([
      '직전 입력과 같은 값입니다(새로 읽은 값인지 확인)',
    ]);
    expect(tabInputWarnings(v, [v, v], 32768)).toEqual([
      '세 시점 값이 모두 같습니다(새로 읽은 값인지 확인)',
    ]);
  });

  it('Windows 2차 입력(272940 → 10007300 → 1007300 K)은 자릿수 경고', () => {
    const base = 272940 / 1024;
    const typo = 10007300 / 1024;
    const settled = 1007300 / 1024;
    expect(tabInputWarnings(typo, [base], 32768)).toEqual([
      '직전 값의 5배 이상입니다(자릿수 확인)',
    ]);
    expect(tabInputWarnings(settled, [base, typo], 32768)).toEqual([
      '직전 값의 1/5 이하입니다(자릿수 확인)',
    ]);
  });

  it('RAM 초과·10 MiB 미만(단위 잘못 고름)', () => {
    expect(tabInputWarnings(40000, [], 32768)).toEqual(['RAM(32768 MiB)보다 큽니다']);
    expect(tabInputWarnings(0.26, [], null)).toEqual(['10 MiB 미만입니다(단위 확인)']);
    expect(tabInputWarnings(300, [280], null)).toEqual([]);
  });
});

describe('bench-input 쪽 판정 지정 쪽', () => {
  it('fixtures/bench/manifest.json 의 judgePages 와 같다', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../../fixtures/bench/manifest.json', import.meta.url), 'utf8'),
    ) as { documents: { id: string; judgePages?: number[] }[] };
    const fromManifest = Object.fromEntries(
      manifest.documents.filter((d) => d.judgePages).map((d) => [d.id, d.judgePages]),
    );
    expect(KNOWN_JUDGE_PAGES).toEqual(fromManifest);
  });

  it('파일 이름으로 문서 id·지정 쪽을 찾는다', () => {
    expect(benchDocOfFile('kogl-mods-cpi-202609.pdf')).toEqual({
      id: 'kogl-mods-cpi-202609',
      judgePages: [3],
    });
    expect(benchDocOfFile('nasa-se-handbook-sp2016-6105.PDF')).toEqual({
      id: 'nasa-se-handbook-sp2016-6105',
    });
  });
});
