#!/usr/bin/env node
// Watches for intermittent MuPDF WASM "memory access out of bounds" aborts (M5 contract 1.2 and 4.1).
// Opens corpus documents, picks pages at random, mixes render, extraction, source link, layout and edit classification calls, forces GC now and then, and does a full save.
// One run is one independent Node process (WASM heap and GC state start fresh each time). The seed differs per run, and the same seed gives the same order.
//
//   pnpm --filter @pdf-editor/core build
//   node packages/core/bench/oob-fuzz.mjs --runs 200 --corpus-dir /mnt/nas4/kjune/pdf-editor/fixtures/corpus --jobs 4
//
// Result: out/m5-oob/<label>.json (seed and result per run; on failure the document, page, step, message and stack). Exit code 1 if there is even one OOB.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const { values: args } = parseArgs({
  options: {
    runs: { type: 'string', default: '200' },
    jobs: { type: 'string', default: '2' },
    'corpus-dir': { type: 'string', default: join(repo, 'fixtures/corpus') },
    docs: {
      type: 'string',
      default:
        'arxiv-2609.09268,zen-ko-moon-21973474,kogl-mods-cpi-202609,nist-ai-100-1,nasa-eo-2024-janfeb,zen-beamer-10545284',
    },
    pages: { type: 'string', default: '10' },
    seed: { type: 'string', default: '1' },
    label: { type: 'string' },
    child: { type: 'boolean', default: false },
    'child-seed': { type: 'string' },
  },
});

const OOB = /memory access out of bounds|unreachable|RuntimeError|table index is out of bounds/i;

function rng(seed) {
  let x = (seed * 2654435761) >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 2 ** 32;
  };
}

async function child() {
  const { PdfSession } = await import('@pdf-editor/core');
  const seed = Number(args['child-seed']);
  const rand = rng(seed);
  const ids = args.docs.split(',');
  const perDoc = Number(args.pages);
  const steps = [];
  let where = { doc: null, page: null, op: null };
  const gc = () => globalThis.gc?.();
  try {
    for (const id of ids) {
      where = { doc: id, page: null, op: 'read' };
      const bytes = new Uint8Array(readFileSync(join(args['corpus-dir'], `${id}.pdf`)));
      const s = new PdfSession();
      where.op = 'open';
      const info = s.open(bytes);
      const pages = new Set([0]);
      while (pages.size < Math.min(perDoc, info.pageCount)) {
        pages.add(Math.floor(rand() * info.pageCount));
      }
      for (const p of pages) {
        where.page = p;
        const ops = [
          'render',
          'extract',
          'extractSeg',
          'sourceMap',
          'link',
          'layout',
          'editability',
        ]
          .map((o) => [rand(), o])
          .sort((a, b) => a[0] - b[0])
          .map((x) => x[1]);
        for (const op of ops) {
          where.op = op;
          if (op === 'render') s.renderPage({ pageIndex: p, scale: 0.75 + rand() });
          else if (op === 'extract') s.extractPage({ pageIndex: p });
          else if (op === 'extractSeg') s.extractPage({ pageIndex: p, includePathSegments: true });
          else if (op === 'sourceMap') s.getSourceMap(p);
          else if (op === 'link') s.linkPage(p);
          else if (op === 'layout') s.getPageLayout(p);
          else await s.getPageEditability(p);
          steps.push(`${id}:${p}:${op}`);
          if (rand() < 0.3) {
            gc();
            await new Promise((r) => setImmediate(r));
          }
        }
      }
      where = { doc: id, page: null, op: 'save' };
      const saved = s.save({ changes: [] });
      where.op = 'reopen';
      const re = new PdfSession();
      re.open(saved.bytes);
      re.renderPage({ pageIndex: 0, scale: 1 });
      re.close();
      s.close();
      gc();
      await new Promise((r) => setImmediate(r));
    }
    process.stdout.write(JSON.stringify({ seed, ok: true, steps: steps.length }) + '\n');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stdout.write(
      JSON.stringify({
        seed,
        ok: false,
        oob: OOB.test(message),
        where,
        message,
        stack: e instanceof Error ? e.stack?.split('\n').slice(0, 8) : null,
        lastSteps: steps.slice(-12),
      }) + '\n',
    );
    process.exitCode = 3;
  }
}

function runChild(seed) {
  return new Promise((done) => {
    const argv = [
      '--expose-gc',
      '--max-old-space-size=8192',
      fileURLToPath(import.meta.url),
      '--child',
      '--child-seed',
      String(seed),
      '--corpus-dir',
      args['corpus-dir'],
      '--docs',
      args.docs,
      '--pages',
      args.pages,
    ];
    const p = spawn(process.execPath, argv, {
      cwd: join(repo, 'packages/core'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code, signal) => {
      const line = out.trim().split('\n').filter(Boolean).at(-1);
      let parsed = null;
      try {
        parsed = line ? JSON.parse(line) : null;
      } catch {
        // Recorded below as an abnormal exit.
      }
      if (parsed) return done({ ...parsed, code });
      done({
        seed,
        ok: false,
        oob: OOB.test(err),
        where: null,
        message: `자식 프로세스 비정상 종료(code=${code}, signal=${signal})`,
        stderrTail: err.split('\n').slice(-12),
        code,
      });
    });
  });
}

async function main() {
  const runs = Number(args.runs);
  const jobs = Number(args.jobs);
  const base = Number(args.seed);
  const results = [];
  let next = 0;
  const started = new Date().toISOString();
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      for (;;) {
        const i = next++;
        if (i >= runs) return;
        const r = await runChild(base * 100000 + i);
        results.push(r);
        process.stderr.write(
          `[${results.length}/${runs}] seed=${r.seed} ${r.ok ? 'ok' : `FAIL oob=${r.oob} ${r.message}`}\n`,
        );
      }
    }),
  );
  results.sort((a, b) => a.seed - b.seed);
  const failures = results.filter((r) => !r.ok);
  const summary = {
    started,
    finished: new Date().toISOString(),
    runs,
    docs: args.docs.split(','),
    pagesPerDoc: Number(args.pages),
    ok: results.length - failures.length,
    failed: failures.length,
    oob: failures.filter((r) => r.oob).length,
    node: process.version,
    mupdf: JSON.parse(
      readFileSync(join(repo, 'packages/core/node_modules/mupdf/package.json'), 'utf8'),
    ).version,
  };
  const label = args.label ?? started.replace(/[:.]/g, '-');
  const outDir = join(repo, 'out/m5-oob');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, `${label}.json`),
    JSON.stringify({ summary, failures, results }, null, 1),
  );
  console.log(JSON.stringify(summary));
  process.exitCode = summary.oob > 0 ? 1 : 0;
}

if (args.child) await child();
else await main();
