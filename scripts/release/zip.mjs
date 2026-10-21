// 결정적 zip(fflate): 항목을 경로순으로 넣고 시각을 고정해 같은 입력이면 같은 바이트가 나온다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// fflate 는 apps/extension 의 개발 의존성이다(저장소 루트에는 설치되지 않는다).
const extRequire = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps', 'extension', 'package.json'),
);
const { zipSync } = extRequire('fflate');

/** 지역 시각 2000-01-01 00:00:00(zip 은 지역 시각을 저장하므로 시간대와 무관하게 같은 값). */
export const ZIP_MTIME = new Date(2000, 0, 1, 0, 0, 0);

export function walkFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walkFiles(p) : [p];
  });
}

/** `dir` 아래 모든 파일을 zip 바이트로 만든다(경로는 `/` 구분, 정렬). */
export function zipDirectory(dir) {
  const entries = walkFiles(dir)
    .map((file) => relative(dir, file).split(sep).join('/'))
    .sort();
  const input = {};
  for (const path of entries) {
    input[path] = [new Uint8Array(readFileSync(join(dir, path))), { mtime: ZIP_MTIME, level: 9 }];
  }
  return zipSync(input);
}
