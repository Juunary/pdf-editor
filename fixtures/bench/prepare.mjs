#!/usr/bin/env node
// 벤치마크 문서를 준비하고 목록(JSON)을 출력한다.
//   node fixtures/bench/prepare.mjs [--tier core,synthetic] [--corpus-dir DIR]
// 코퍼스: <corpusDir>/<id>.pdf 가 있어야 한다(없으면 오류, 내려받기는 scripts/corpus/fetch-corpus.mjs).
// 합성: <outDir>/<id>.pdf 가 없거나 해시가 다르면 생성기로 다시 만든다. 대용량 실제 문서 자리(url: null)는 건너뛴다.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const { values } = parseArgs({
  options: { tier: { type: 'string', default: 'core' }, 'corpus-dir': { type: 'string' } },
});
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
const corpusManifest = JSON.parse(readFileSync(join(repo, manifest.corpusDir, 'manifest.json'), 'utf8'));
const corpusDir = values['corpus-dir']
  ? resolve(values['corpus-dir'])
  : isAbsolute(manifest.corpusDir)
    ? manifest.corpusDir
    : join(repo, manifest.corpusDir);
const outDir = join(repo, manifest.outDir);
const tiers = new Set(values.tier.split(','));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const list = [];
for (const doc of manifest.documents) {
  if (!tiers.has(doc.tier)) continue;
  if (doc.source === 'corpus') {
    const entry = corpusManifest.documents.find((d) => d.id === doc.id);
    if (!entry) throw new Error(`코퍼스 manifest 에 ${doc.id} 없음`);
    const path = join(corpusDir, `${doc.id}.pdf`);
    if (!existsSync(path)) throw new Error(`${path} 없음(scripts/corpus/fetch-corpus.mjs 로 받는다)`);
    if (statSync(path).size !== entry.bytes || sha256(path) !== entry.sha256) {
      throw new Error(`${doc.id}: 코퍼스 해시 불일치`);
    }
    list.push({ id: doc.id, path, bytes: entry.bytes, pages: entry.pages, role: doc.role, judgePages: doc.judgePages });
  } else if (doc.source === 'synthetic') {
    const path = join(outDir, `${doc.id}.pdf`);
    if (!existsSync(path) || statSync(path).size !== doc.bytes || sha256(path) !== doc.sha256) {
      const a = doc.args;
      execFileSync(
        process.execPath,
        [join(here, 'synth.mjs'), '--kind', a.kind, '--pages', String(a.pages), '--seed', String(a.seed), '--out', path],
        { stdio: ['ignore', 'ignore', 'inherit'] },
      );
      if (sha256(path) !== doc.sha256) throw new Error(`${doc.id}: 합성 해시 불일치(생성기 변경?)`);
    }
    list.push({ id: doc.id, path, bytes: doc.bytes, pages: doc.pages, role: doc.role });
  } else if (doc.source === 'external') {
    if (!doc.url) continue; // 자리만 있음
    const path = join(outDir, `${doc.id}.pdf`);
    if (!existsSync(path) || sha256(path) !== doc.sha256) {
      throw new Error(`${doc.id}: ${path} 없음(메인 세션 다운로드 스크립트로 받는다)`);
    }
    list.push({ id: doc.id, path, bytes: doc.bytes, pages: null, role: doc.role });
  }
}
process.stdout.write(JSON.stringify(list, null, 2) + '\n');
