// M0 Day 1 spike runner.
//
//   pnpm spike                      # run everything → out/m0-day1/spike-result.json, summary.md
//   pnpm spike -- --bench-pages 50  # change the synthetic benchmark page count
//   pnpm --filter @pdf-editor/spike-m0 fixtures   # refresh fixtures/m0/*.pdf
//   pnpm --filter @pdf-editor/spike-m0 spike:xobject  # shared Form XObject → out/m0-dod/xobject-result.json
//   pnpm --filter @pdf-editor/spike-m0 spike:redact   # existing Redact annotations → out/m0-dod/redact-result.json
//   pnpm --filter @pdf-editor/spike-m0 spike:save-bench  # large-document save limit → out/m0-dod/save-bench-result.json
//   pnpm --filter @pdf-editor/spike-m0 spike:corpus   # rerun on the real corpus → out/m0-corpus/corpus-result.json
//     (-- --no-subset --out out/m0-corpus-nosubset: control run that skips subsetFonts() before saving)
//   pnpm --filter @pdf-editor/spike-m0 spike:pdfjs    # pdf.js (pdfjs-dist) check → out/m0-corpus/pdfjs-result.json
//   pnpm --filter @pdf-editor/spike-m0 spike:objstms  # full-save objstms verification (A3-7) → out/m0-dod/objstms/objstms-result.json
//
// To keep peak memory from mixing, each measured target (spike variant, benchmark) runs in its own Node process.
// WASM linear memory never shrinks, so the value at process exit is that task's maximum.
import { wasmHeapBytes } from '@pdf-editor/core';
import * as mupdf from 'mupdf';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBenchFull, runBenchIncremental } from './bench.js';
import {
  runRedactCli,
  runSaveBenchCli,
  runSaveChild,
  runXObjectCli,
  writeDodFixtures,
} from './dod-cli.js';
import { runCorpusChild, runCorpusCli } from './corpus-cli.js';
import { buildSamplePdf, buildSyntheticPdf } from './fixture.js';
import { runObjstmsChild, runObjstmsCli } from './objstms-check.js';
import { runPdfjsCli } from './pdfjs-check.js';
import { runIncrementalControls, runSpike, SEARCH_TERMS, REPLACEMENT_TEXT } from './spike.js';

const CLI = fileURLToPath(import.meta.url);
const ROOT = join(dirname(CLI), '..', '..', '..');
const FONTS = {
  ttf: join(ROOT, 'assets/fonts/NotoSansKR-Regular-subset.ttf'),
  otf: join(ROOT, 'assets/fonts/src/NotoSansKR-Regular.otf'),
} as const;
type FontVariant = keyof typeof FONTS;

interface Mark {
  phase: string;
  tMs: number;
  wasmHeapBytes: number | null;
  rssBytes: number;
}

interface ChildReport {
  task: string;
  marks: Mark[];
  maxRssBytes: number;
  result: unknown;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const mib = (n: number | null) => (n === null ? 'n/a' : (n / 1048576).toFixed(1));

function createMarker(): { marks: Mark[]; mark: (phase: string) => void } {
  const start = performance.now();
  const marks: Mark[] = [];
  const mark = (phase: string) =>
    marks.push({
      phase,
      tMs: performance.now() - start,
      wasmHeapBytes: wasmHeapBytes(),
      rssBytes: process.memoryUsage().rss,
    });
  mark('start');
  return { marks, mark };
}

// ---------------------------------------------------------------- child

function runChild(task: string, out: string): void {
  const { marks, mark } = createMarker();
  let result: unknown;
  if (task.startsWith('spike:')) {
    const variant = task.slice(6) as FontVariant;
    const fontBytes = new Uint8Array(readFileSync(FONTS[variant]));
    const r = runSpike({
      sampleBytes: new Uint8Array(readFileSync(join(out, 'sample.pdf'))),
      expectedBytes: new Uint8Array(readFileSync(join(out, 'expected.pdf'))),
      fontBytes,
      fontName: 'NotoSansKR',
      onPhase: mark,
    });
    const { savedBytes, ...rest } = r;
    writeFileSync(join(out, `${variant}-saved.pdf`), savedBytes);
    result = {
      ...rest,
      font: {
        variant,
        path: relative(ROOT, FONTS[variant]),
        bytes: fontBytes.byteLength,
        sha256: sha256(fontBytes),
      },
      savedSha256: sha256(savedBytes),
    };
  } else if (task === 'bench-full' || task === 'bench-incremental') {
    const input = new Uint8Array(readFileSync(join(out, 'synthetic.pdf')));
    const r =
      task === 'bench-full'
        ? runBenchFull(input, new Uint8Array(readFileSync(FONTS.ttf)), mark)
        : runBenchIncremental(input, mark);
    const { output, ...rest } = r;
    void output;
    result = rest;
  } else {
    throw new Error(`알 수 없는 작업: ${task}`);
  }
  const report: ChildReport = {
    task,
    marks,
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
    result,
  };
  writeFileSync(join(out, `${task.replace(':', '-')}.json`), JSON.stringify(report, null, 2));

  // After measuring: PNG for visual check (MuPDF render)
  if (task.startsWith('spike:')) {
    const variant = task.slice(6);
    const doc = mupdf.Document.openDocument(
      readFileSync(join(out, `${variant}-saved.pdf`)),
      'application/pdf',
    );
    const png = doc
      .loadPage(0)
      .toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false)
      .asPNG();
    writeFileSync(join(out, `${variant}-saved-mupdf.png`), png);
  }
}

// ---------------------------------------------------------------- parent

function spawnChild(task: string, out: string): ChildReport {
  const r = spawnSync(process.execPath, [CLI, '--child', task, '--out', out], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (r.status !== 0) throw new Error(`${task} 실패(exit ${r.status})`);
  return JSON.parse(
    readFileSync(join(out, `${task.replace(':', '-')}.json`), 'utf8'),
  ) as ChildReport;
}

function tool(cmd: string, args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { ok: r.status === 0, stdout: r.status === 0 ? r.stdout : (r.stderr ?? String(r.error)) };
}

/** Re-extract and check the font table with Poppler (an independent implementation). available=false if absent. */
function popplerCheck(pdf: string, pngPrefix: string): Record<string, unknown> {
  const version = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' });
  if (version.error) return { available: false };
  const text = tool('pdftotext', ['-enc', 'UTF-8', '-layout', pdf, '-']);
  const fonts = tool('pdffonts', [pdf]);
  tool('pdftoppm', ['-r', '108', '-png', '-f', '1', '-l', '1', '-singlefile', pdf, pngPrefix]);
  const squash = (s: string) => s.replace(/\s+/g, '');
  return {
    available: true,
    version: (version.stderr || version.stdout).split('\n')[0],
    textFound: squash(text.stdout).includes(squash(REPLACEMENT_TEXT)),
    searchTermsFound: Object.fromEntries(
      SEARCH_TERMS.map((t) => [t, squash(text.stdout).includes(squash(t))]),
    ),
    pdffonts: fonts.stdout.trim().split('\n'),
  };
}

function environment(): Record<string, unknown> {
  const require = createRequire(import.meta.url);
  const mupdfPkg = JSON.parse(
    readFileSync(join(dirname(require.resolve('mupdf')), '..', 'package.json'), 'utf8'),
  ) as { version: string };
  return {
    date: new Date().toISOString(),
    host: os.hostname(),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model,
    cpuCount: os.cpus().length,
    memTotalGiB: +(os.totalmem() / 2 ** 30).toFixed(1),
    node: process.version,
    mupdf: mupdfPkg.version,
  };
}

function phaseTable(report: ChildReport): string {
  const rows = report.marks.map((m, i) => {
    const prev = report.marks[i - 1];
    const dt = prev ? (m.tMs - prev.tMs).toFixed(1) : '-';
    return `| ${m.phase} | ${m.tMs.toFixed(1)} | ${dt} | ${mib(m.wasmHeapBytes)} | ${mib(m.rssBytes)} |`;
  });
  return [
    '| 단계 | 누적 ms | 구간 ms | WASM 힙 MiB | RSS MiB |',
    '|---|---|---|---|---|',
    ...rows,
    `| (프로세스 maxRSS) | | | | ${mib(report.maxRssBytes)} |`,
  ].join('\n');
}

function runParent(): void {
  const out = join(ROOT, arg('--out') ?? 'out/m0-day1');
  mkdirSync(out, { recursive: true });
  const benchPages = Number(arg('--bench-pages') ?? 100);
  const env = environment();

  const sample = buildSamplePdf();
  writeFileSync(join(out, 'sample.pdf'), sample);
  writeFileSync(join(out, 'expected.pdf'), buildSamplePdf({ includeTarget: false }));

  const variants: FontVariant[] = existsSync(FONTS.otf) ? ['ttf', 'otf'] : ['ttf'];
  const spikes = Object.fromEntries(variants.map((v) => [v, spawnChild(`spike:${v}`, out)]));
  const poppler = Object.fromEntries(
    variants.map((v) => [
      v,
      popplerCheck(join(out, `${v}-saved.pdf`), join(out, `${v}-saved-poppler`)),
    ]),
  );
  const controls = runIncrementalControls(sample);

  const t0 = performance.now();
  const synthetic = buildSyntheticPdf(benchPages);
  writeFileSync(join(out, 'synthetic.pdf'), synthetic);
  const syntheticGenMs = performance.now() - t0;
  const benchFull = spawnChild('bench-full', out);
  const benchIncremental = spawnChild('bench-incremental', out);

  const summary = {
    environment: env,
    sample: { bytes: sample.byteLength, sha256: sha256(sample) },
    spikes,
    poppler,
    incrementalControls: controls,
    benchmark: {
      synthetic: { pages: benchPages, bytes: synthetic.byteLength, generationMs: syntheticGenMs },
      full: benchFull,
      incremental: benchIncremental,
    },
  };
  writeFileSync(join(out, 'spike-result.json'), JSON.stringify(summary, null, 2));

  const md: string[] = [
    `# M0 Day 1 스파이크 결과 (${env.date})`,
    '',
    '```json',
    JSON.stringify(env, null, 2),
    '```',
    '',
  ];
  for (const v of variants) md.push(`## spike:${v}`, '', phaseTable(spikes[v]!), '');
  md.push(
    '## bench-full',
    '',
    phaseTable(benchFull),
    '',
    '## bench-incremental',
    '',
    phaseTable(benchIncremental),
    '',
  );
  writeFileSync(join(out, 'summary.md'), md.join('\n'));
  console.log(md.join('\n'));
  console.log(`\n결과: ${relative(ROOT, join(out, 'spike-result.json'))}`);
}

/** Fixed files for manual verification: the sample original and the spike save result (TTF). Output is deterministic. */
function writeFixtures(): void {
  const dir = join(ROOT, 'fixtures/m0');
  const diag = join(ROOT, 'apps/extension/public/diag');
  mkdirSync(dir, { recursive: true });
  mkdirSync(diag, { recursive: true });
  const sample = buildSamplePdf();
  const saved = runSpike({
    sampleBytes: sample,
    expectedBytes: buildSamplePdf({ includeTarget: false }),
    fontBytes: new Uint8Array(readFileSync(FONTS.ttf)),
    fontName: 'NotoSansKR',
  }).savedBytes;
  for (const [name, bytes] of [
    ['m0-sample.pdf', sample],
    ['m0-spike-saved.pdf', saved],
  ] as const) {
    writeFileSync(join(dir, name), bytes);
    copyFileSync(join(dir, name), join(diag, name));
    console.log(`${name}: ${bytes.byteLength} B, sha256 ${sha256(bytes)}`);
  }
  // M0 DoD remaining-item fixtures (placed only in fixtures/m0)
  for (const { name, bytes } of writeDodFixtures(ROOT, FONTS.ttf)) {
    writeFileSync(join(dir, name), bytes);
    console.log(`${name}: ${bytes.byteLength} B, sha256 ${sha256(bytes)}`);
  }
}

const dodPaths = () => ({
  root: ROOT,
  out: join(ROOT, arg('--out') ?? 'out/m0-dod'),
  ttf: FONTS.ttf,
});

const child = arg('--child');
if (child?.startsWith('save:')) runSaveChild(child, arg('--input')!, arg('--out')!, FONTS.ttf);
else if (child?.startsWith('corpus-'))
  runCorpusChild(
    child,
    arg('--input')!,
    arg('--plan'),
    arg('--out')!,
    FONTS.ttf,
    !process.argv.includes('--no-subset'),
  );
else if (child?.startsWith('objstms-'))
  runObjstmsChild(child, arg('--spec')!).catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
else if (child) runChild(child, arg('--out')!);
else if (process.argv.includes('--write-fixtures')) writeFixtures();
else if (process.argv.includes('--xobject')) runXObjectCli(dodPaths());
else if (process.argv.includes('--redact-existing')) runRedactCli(dodPaths());
else if (process.argv.includes('--corpus')) {
  runCorpusCli({
    root: ROOT,
    out: join(ROOT, arg('--out') ?? 'out/m0-corpus'),
    only: arg('--only')?.split(',') ?? null,
    subsetFonts: !process.argv.includes('--no-subset'),
  });
} else if (process.argv.includes('--pdfjs')) {
  runPdfjsCli({ root: ROOT, corpusOut: join(ROOT, arg('--out') ?? 'out/m0-corpus') }).catch(
    (e: unknown) => {
      console.error(e);
      process.exit(1);
    },
  );
} else if (process.argv.includes('--objstms')) {
  runObjstmsCli({
    root: ROOT,
    out: join(ROOT, arg('--out') ?? 'out/m0-dod/objstms'),
    ttf: FONTS.ttf,
    tmp: arg('--tmp') ?? os.tmpdir(),
    only: arg('--only')?.split(',') ?? null,
  }).catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
} else if (process.argv.includes('--save-bench')) {
  runSaveBenchCli(dodPaths(), (arg('--large-pages') ?? '500,700,900').split(',').map(Number));
} else runParent();
