// 실제 코퍼스(fixtures/corpus/manifest.json) 내려받기·SHA-256 검증. PDF 는 커밋하지 않는다(.gitignore).
//
//   node scripts/corpus/fetch-corpus.mjs            # 없는 문서만 받고 전부 검증
//   node scripts/corpus/fetch-corpus.mjs --check    # 받지 않고 검증만
//   node scripts/corpus/fetch-corpus.mjs --only id1,id2
//
// 해시가 다르면 파일을 남기지 않고(.part 삭제) 실패로 끝난다. 출처가 같은 URL 로 다른 판을 배포하면
// manifest 의 sha256 을 갱신하기 전에 라이선스·내용을 다시 확인한다.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(ROOT, 'fixtures', 'corpus');
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));
const checkOnly = process.argv.includes('--check');
const onlyArg = process.argv[process.argv.indexOf('--only') + 1];
const only = process.argv.includes('--only') ? new Set(onlyArg.split(',')) : null;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

let failed = 0;
for (const d of manifest.documents) {
  if (only && !only.has(d.id)) continue;
  const file = join(DIR, `${d.id}.pdf`);
  if (!existsSync(file) && !checkOnly) {
    const res = await fetch(d.url, {
      headers: {
        'user-agent': 'pdf-editor-corpus-fetch/1 (+https://github.com/Juunary/pdf-editor)',
      },
      redirect: 'follow',
    });
    if (!res.ok) {
      console.error(`${d.id}: HTTP ${res.status} ${d.url}`);
      failed++;
      continue;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const part = `${file}.part`;
    writeFileSync(part, bytes);
    if (sha256(bytes) !== d.sha256) {
      rmSync(part);
      console.error(`${d.id}: sha256 불일치(받은 ${sha256(bytes)}, manifest ${d.sha256})`);
      failed++;
      continue;
    }
    renameSync(part, file);
  }
  if (!existsSync(file)) {
    console.error(`${d.id}: 파일 없음`);
    failed++;
    continue;
  }
  const bytes = readFileSync(file);
  const ok = sha256(bytes) === d.sha256 && bytes.byteLength === d.bytes;
  if (!ok) failed++;
  console.log(`${ok ? 'OK ' : 'BAD'} ${d.id} ${d.type} ${bytes.byteLength} B ${d.license}`);
}
if (failed) {
  console.error(`실패 ${failed}건`);
  process.exit(1);
}
