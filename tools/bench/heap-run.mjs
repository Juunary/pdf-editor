// 저장 힙 측정 실행기(docs/m5-heap.md 2절). 문서 × 저장 경로마다 heap-child.mjs 를 새 프로세스로 돌려 JSON 줄로 모은다.
// 사용: node tools/bench/heap-run.mjs [--corpus <dir>] [--only id,id] [--jobs N] [--out out/m5-heap/measure.jsonl]
//   [--variants full,none] [--views 0,3,10,30] [--synth-dir <dir>]
// 같은 세션 저장 2회는 --variants full2,none2(heap-child.mjs, docs/m5-heap.md 4.4). 판정은 heap-check-twice.mjs.
// 합성 문서가 없으면 synth.mjs 로 만든다(--synth-dir 로 저장소 밖에 둘 수 있다). 코퍼스는 fixtures/corpus/manifest.json 의 id 를 쓴다(PDF 는 git 밖).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYNTHETIC, writeSynthetic } from './synth.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHILD = join(ROOT, 'tools/bench/heap-child.mjs');
const VARIANTS = (arg('variants', 'full,none') ?? 'full,none').split(',');
/** 저장 전에 넘겨 본 쪽 수(힙 이력). 같은 문서도 이력에 따라 피크 계단이 달라 시나리오마다 잰다(docs/m5-heap.md 2절). */
const VIEWS = (arg('views', '0,3,10,30') ?? '0').split(',').map(Number);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const docsCfg = JSON.parse(readFileSync(join(ROOT, 'tools/bench/heap-docs.json'), 'utf8'));
const corpusDir = resolve(ROOT, arg('corpus', docsCfg.corpusDir));
const synthDir = resolve(ROOT, arg('synth-dir', docsCfg.synthDir));
const outPath = resolve(ROOT, arg('out', 'out/m5-heap/measure.jsonl'));
const jobs = Number(arg('jobs', '6'));
const only = arg('only', null)?.split(',');

/** [{ id, group, path }] */
function documents() {
  const docs = [];
  const manifest = JSON.parse(readFileSync(join(ROOT, 'fixtures/corpus/manifest.json'), 'utf8'));
  for (const entry of manifest.documents ?? manifest) {
    docs.push({ id: entry.id, group: 'corpus', path: join(corpusDir, `${entry.id}.pdf`) });
  }
  for (const id of Object.keys(SYNTHETIC)) {
    docs.push({ id, group: 'synthetic', path: join(synthDir, `${id}.pdf`) });
  }
  for (const slot of docsCfg.realLarge) {
    if (slot.id && slot.path)
      docs.push({ id: slot.id, group: 'real-large', path: resolve(ROOT, slot.path) });
  }
  return only ? docs.filter((d) => only.includes(d.id)) : docs;
}

function runChild(doc, variant, view) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CHILD, doc.path, variant, String(view)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code, signal) => {
      let r;
      try {
        r = JSON.parse(stdout.trim().split('\n').at(-1));
      } catch {
        // 프로세스가 죽었다(WASM 힙 상한 밖 abort 등). 미탐 판정에서 실패로 센다.
        r = {
          path: doc.path,
          variant,
          viewPages: view,
          ok: false,
          error: `exit ${code ?? signal}: ${stderr.slice(-400)}`,
        };
      }
      done({ id: doc.id, group: doc.group, ...r });
    });
  });
}

const docs = documents();
mkdirSync(synthDir, { recursive: true });
for (const d of docs) {
  if (d.group === 'synthetic' && !existsSync(d.path)) {
    process.stderr.write(`생성 ${d.id}\n`);
    writeSynthetic(d.id, d.path);
  }
}
const missing = docs.filter((d) => !existsSync(d.path));
if (missing.length) throw new Error(`문서 없음: ${missing.map((d) => d.path).join(', ')}`);

// 큰 문서부터(피크 메모리가 큰 작업을 먼저 흩어 놓는다).
const { statSync } = await import('node:fs');
const tasks = docs
  .flatMap((d) =>
    VARIANTS.flatMap((v) => VIEWS.map((view) => ({ d, v, view, size: statSync(d.path).size }))),
  )
  .sort((a, b) => b.size - a.size);
const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: jobs }, async () => {
    while (next < tasks.length) {
      const t = tasks[next++];
      const r = await runChild(t.d, t.v, t.view);
      results.push(r);
      process.stderr.write(
        `${r.ok ? 'ok ' : 'ERR'} ${t.d.id} ${t.v} view=${t.view} peak=${r.peak ? (r.peak / 2 ** 20).toFixed(1) : '-'} MiB${r.error ? ` ${r.error.slice(0, 120)}` : ''}\n`,
      );
    }
  }),
);
results.sort(
  (a, b) =>
    a.id.localeCompare(b.id) || a.variant.localeCompare(b.variant) || a.viewPages - b.viewPages,
);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, results.map((r) => JSON.stringify(r)).join('\n') + '\n');
process.stderr.write(`${results.length}건 → ${outPath}\n`);
