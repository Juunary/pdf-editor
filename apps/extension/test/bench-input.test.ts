import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  KNOWN_JUDGE_PAGES,
  benchDocOfFile,
  parseTabInput,
  tabInputWarnings,
} from '../src/viewer/bench-input.js';

describe('bench-input tab memory input', () => {
  it('converts the Task Manager K value to MiB (commas and suffix allowed)', () => {
    expect(parseTabInput('272940', 'K')).toEqual({ mib: 272940 / 1024, raw: '272940', unit: 'K' });
    expect(parseTabInput('272,940K', 'MiB')).toMatchObject({ mib: 272940 / 1024, unit: 'K' });
    expect(parseTabInput(' 983.7 ', 'MiB')).toMatchObject({ mib: 983.7, unit: 'MiB' });
    expect(parseTabInput('1.5 GB', 'K')).toMatchObject({ mib: 1536, unit: 'MiB' });
    expect(parseTabInput('266 MB', 'K')).toMatchObject({ mib: 266, unit: 'MiB' });
  });

  it('null if not a number or 0 or less', () => {
    expect(parseTabInput('', 'K').mib).toBeNull();
    expect(parseTabInput('abc', 'K').mib).toBeNull();
    expect(parseTabInput('0', 'MiB').mib).toBeNull();
    expect(parseTabInput('-5', 'MiB').mib).toBeNull();
  });

  it('Windows first-round input (three points at 42420 K) gives the same-value warning, and the third gives the all-same warning', () => {
    const v = 42420 / 1024;
    expect(tabInputWarnings(v, [], 32768)).toEqual([]);
    expect(tabInputWarnings(v, [v], 32768)).toEqual([
      '직전 입력과 같은 값입니다(새로 읽은 값인지 확인)',
    ]);
    expect(tabInputWarnings(v, [v, v], 32768)).toEqual([
      '세 시점 값이 모두 같습니다(새로 읽은 값인지 확인)',
    ]);
  });

  it('Windows second-round input (272940 → 10007300 → 1007300 K) gives the magnitude warning', () => {
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

  it('exceeding RAM, and under 10 MiB (wrong unit chosen)', () => {
    expect(tabInputWarnings(40000, [], 32768)).toEqual(['RAM(32768 MiB)보다 큽니다']);
    expect(tabInputWarnings(0.26, [], null)).toEqual(['10 MiB 미만입니다(단위 확인)']);
    expect(tabInputWarnings(300, [280], null)).toEqual([]);
  });
});

describe('bench-input pages designated for page classification', () => {
  it('matches judgePages in fixtures/bench/manifest.json', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../../fixtures/bench/manifest.json', import.meta.url), 'utf8'),
    ) as { documents: { id: string; judgePages?: number[] }[] };
    const fromManifest = Object.fromEntries(
      manifest.documents.filter((d) => d.judgePages).map((d) => [d.id, d.judgePages]),
    );
    expect(KNOWN_JUDGE_PAGES).toEqual(fromManifest);
  });

  it('finds the document id and designated pages from the file name', () => {
    expect(benchDocOfFile('kogl-mods-cpi-202609.pdf')).toEqual({
      id: 'kogl-mods-cpi-202609',
      judgePages: [3],
    });
    expect(benchDocOfFile('nasa-se-handbook-sp2016-6105.PDF')).toEqual({
      id: 'nasa-se-handbook-sp2016-6105',
    });
  });
});
