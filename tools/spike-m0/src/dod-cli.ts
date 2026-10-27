// Runner for the remaining M0 DoD items (shared XObject, existing Redact annotations, large-document save). Called from cli.ts.
import * as mupdf from 'mupdf';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPreexistingRedactPdf } from './fixture-redact.js';
import { buildSharedXObjectPdf } from './fixture-xobject.js';
import { buildSyntheticPdf } from './fixture.js';
import {
  runSaveVariant,
  SAVE_VARIANTS,
  writeLargePdf,
  type SaveBenchResult,
} from './save-bench.js';
import { popplerPng, popplerRaster, popplerText, popplerVersion, ppmDiff } from './poppler.js';
import { REDACT_CASES, runRedactCase } from './redact-spike.js';
import { ADJACENT_LINES } from './fixture.js';
import { REPLACEMENT_TEXT } from './spike.js';
import {
  BADGE_REPLACEMENT,
  CARD_REPLACEMENT,
  runXObjectCase,
  XOBJECT_CASES,
  type XObjectCaseResult,
} from './xobject-spike.js';

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** PDF user-space rectangle (A4, no rotation) → pdftoppm pixel rectangle (2px margin). */
function popplerPixelRect(r: [number, number, number, number], dpi: number, pageHeight = 842) {
  const s = dpi / 72;
  return [
    Math.floor(r[0] * s) - 2,
    Math.floor((pageHeight - r[3]) * s) - 2,
    Math.ceil(r[2] * s) + 2,
    Math.ceil((pageHeight - r[1]) * s) + 2,
  ] as [number, number, number, number];
}
const squash = (s: string) => s.replace(/\s+/g, '');

export interface DodPaths {
  root: string;
  out: string;
  ttf: string;
}

/** Shared Form XObject spike: per-case result JSON, saved PDF, PNG + Poppler cross-check. */
export function runXObjectCli({ root, out, ttf }: DodPaths): void {
  mkdirSync(out, { recursive: true });
  const fontBytes = new Uint8Array(readFileSync(ttf));
  const originalPath = join(out, 'xobject-original.pdf');
  const original = buildSharedXObjectPdf('original');
  writeFileSync(originalPath, original);
  const poppler = popplerVersion();
  const originalPpm = poppler
    ? [1, 2].map((p) => popplerRaster(originalPath, p, join(out, `tmp-orig-${p}`)))
    : null;
  const originalText2 = poppler ? popplerText(originalPath, 2) : null;

  const results: Record<string, unknown> = {};
  for (const c of XOBJECT_CASES) {
    const r: XObjectCaseResult = runXObjectCase(c, { fontBytes });
    const { savedBytes, ...rest } = r;
    const pdf = join(out, `xobject-${c}.pdf`);
    writeFileSync(pdf, savedBytes);
    const doc = mupdf.Document.openDocument(savedBytes, 'application/pdf');
    writeFileSync(
      join(out, `xobject-${c}-p1-mupdf.png`),
      doc
        .loadPage(0)
        .toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false)
        .asPNG(),
    );
    doc.destroy();
    let popplerResult: Record<string, unknown> = { available: false };
    if (poppler && originalPpm && originalText2 !== null) {
      popplerPng(pdf, 1, join(out, `xobject-${c}-p1-poppler`));
      const t1 = popplerText(pdf, 1);
      const expectTexts =
        c === 'depth1'
          ? [CARD_REPLACEMENT]
          : c === 'depth2'
            ? [BADGE_REPLACEMENT]
            : c === 'sequential'
              ? [CARD_REPLACEMENT, BADGE_REPLACEMENT]
              : [];
      popplerResult = {
        available: true,
        version: poppler,
        page2DiffPx: ppmDiff(originalPpm[1]!, popplerRaster(pdf, 2, join(out, 'tmp-2'))),
        page1DiffPx: ppmDiff(originalPpm[0]!, popplerRaster(pdf, 1, join(out, 'tmp-1'))),
        page1OutsideSelectedDiffPx: ppmDiff(
          originalPpm[0]!,
          popplerRaster(pdf, 1, join(out, 'tmp-1')),
          popplerPixelRect(r.selectedPageBox, 108),
        ),
        page2TextSame: popplerText(pdf, 2) === originalText2,
        page1NewTextFound: expectTexts.map((t) => squash(t1).includes(squash(t))),
      };
    }
    results[c] = { ...rest, savedSha256: sha256(savedBytes), poppler: popplerResult };
    console.log(`${c}: ${savedBytes.byteLength} B → ${relative(root, pdf)}`);
  }
  const summary = {
    date: new Date().toISOString(),
    fixture: { bytes: original.byteLength, sha256: sha256(original) },
    cases: results,
  };
  writeFileSync(join(out, 'xobject-result.json'), JSON.stringify(summary, null, 2));
  console.log(`결과: ${relative(root, join(out, 'xobject-result.json'))}`);
}

/** Document with existing Redact annotations: per-case result JSON, saved PDF + Poppler cross-check. */
export function runRedactCli({ root, out, ttf }: DodPaths): void {
  mkdirSync(out, { recursive: true });
  const fontBytes = new Uint8Array(readFileSync(ttf));
  const originalPath = join(out, 'redact-original.pdf');
  const original = buildPreexistingRedactPdf();
  writeFileSync(originalPath, original);
  const poppler = popplerVersion();
  const originalPpm2 = poppler ? popplerRaster(originalPath, 2, join(out, 'tmp-orig-2')) : null;
  const results: Record<string, unknown> = {};
  for (const c of REDACT_CASES) {
    const { savedBytes, ...rest } = runRedactCase(c, fontBytes);
    const pdf = join(out, `redact-${c}.pdf`);
    writeFileSync(pdf, savedBytes);
    let popplerResult: Record<string, unknown> = { available: false };
    if (poppler && originalPpm2) {
      const t1 = squash(popplerText(pdf, 1));
      popplerPng(pdf, 1, join(out, `redact-${c}-p1-poppler`));
      popplerResult = {
        available: true,
        version: poppler,
        page2DiffPx: ppmDiff(originalPpm2, popplerRaster(pdf, 2, join(out, 'tmp-2'))),
        adjacentTextFound: ADJACENT_LINES.every((l) => t1.includes(squash(l))),
        newTextFound: t1.includes(squash(REPLACEMENT_TEXT)),
      };
    }
    results[c] = { ...rest, savedSha256: sha256(savedBytes), poppler: popplerResult };
    console.log(`${c}: ${savedBytes.byteLength} B → ${relative(root, pdf)}`);
  }
  const summary = {
    date: new Date().toISOString(),
    fixture: { bytes: original.byteLength, sha256: sha256(original) },
    cases: results,
  };
  writeFileSync(join(out, 'redact-result.json'), JSON.stringify(summary, null, 2));
  console.log(`결과: ${relative(root, join(out, 'redact-result.json'))}`);
}

/** Fixed fixtures (same bytes on regeneration): the originals and edit results of the shared-XObject and existing-Redact-annotation documents. */
export function writeDodFixtures(root: string, ttf: string): { name: string; bytes: Uint8Array }[] {
  const fontBytes = new Uint8Array(readFileSync(ttf));
  return [
    { name: 'm0-shared-xobject.pdf', bytes: buildSharedXObjectPdf('original') },
    {
      name: 'm0-shared-xobject-edited.pdf',
      bytes: runXObjectCase('sequential', { fontBytes }).savedBytes,
    },
    { name: 'm0-preexisting-redact.pdf', bytes: buildPreexistingRedactPdf() },
    {
      name: 'm0-preexisting-redact-edited.pdf',
      bytes: runRedactCase('per-annotation', fontBytes).savedBytes,
    },
  ];
}

/** Child process: run one save variant → JSON. */
export function runSaveChild(task: string, input: string, outFile: string, ttf: string): void {
  const result = runSaveVariant(
    task.slice('save:'.length),
    new Uint8Array(readFileSync(input)),
    new Uint8Array(readFileSync(ttf)),
  );
  writeFileSync(
    outFile,
    JSON.stringify({ ...result, maxRssBytes: process.resourceUsage().maxRSS * 1024 }, null, 2),
  );
}

interface SaveRun extends Partial<SaveBenchResult> {
  doc: string;
  variant: string;
  exitCode: number | null;
  signal: string | null;
  stderrTail: string | null;
  maxRssBytes?: number;
}

/**
 * Large-document save limit investigation (A4). Synthetic 100·300 pages (Day 1 generator) × save variants, and near-2 GiB
 * large documents (generated directly in JS) × buffer/stream input. A separate process per variant.
 */
export function runSaveBenchCli({ root, out }: DodPaths, largePages: number[]): void {
  const dir = join(out, 'save-bench');
  mkdirSync(dir, { recursive: true });
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
  const docs: { name: string; path: string; bytes: number }[] = [];
  for (const pages of [100, 300]) {
    const path = join(dir, `synthetic-${pages}.pdf`);
    if (!existsSync(path)) writeFileSync(path, buildSyntheticPdf(pages));
    docs.push({ name: `synthetic-${pages}`, path, bytes: readFileSync(path).byteLength });
  }
  for (const pages of largePages) {
    const path = join(dir, `large-${pages}.pdf`);
    const bytes = existsSync(path) ? readFileSync(path).byteLength : writeLargePdf(path, pages);
    docs.push({ name: `large-${pages}`, path, bytes });
  }
  const runs: SaveRun[] = [];
  for (const d of docs) {
    const variants = d.name.startsWith('large')
      ? ['buffer-compact', 'stream-compact', 'stream-gc1']
      : Object.keys(SAVE_VARIANTS);
    for (const variant of variants) {
      const outFile = join(dir, `${d.name}-${variant}.json`);
      rmSync(outFile, { force: true });
      const t0 = performance.now();
      const r = spawnSync(
        process.execPath,
        [cli, '--child', `save:${variant}`, '--input', d.path, '--out', outFile],
        { encoding: 'utf8', maxBuffer: 1 << 24 },
      );
      const run: SaveRun = {
        doc: d.name,
        variant,
        exitCode: r.status,
        signal: r.signal,
        stderrTail: r.status === 0 ? null : (r.stderr ?? '').split('\n').slice(-6).join('\n'),
      };
      if (existsSync(outFile)) Object.assign(run, JSON.parse(readFileSync(outFile, 'utf8')));
      runs.push(run);
      const heap = run.marks?.at(-1)?.wasmHeapBytes;
      console.log(
        `${d.name} (${(d.bytes / 2 ** 20).toFixed(1)} MiB) ${variant}: ${run.ok ? 'ok' : `실패(${run.error ?? r.status})`}` +
          ` 힙 ${heap ? (heap / 2 ** 20).toFixed(1) : '?'} MiB, 배율 ${run.peakRatio?.toFixed(2) ?? '?'}, ${(performance.now() - t0).toFixed(0)} ms`,
      );
    }
  }
  const summary = {
    date: new Date().toISOString(),
    docs: docs.map((d) => ({ name: d.name, bytes: d.bytes })),
    runs,
  };
  writeFileSync(join(out, 'save-bench-result.json'), JSON.stringify(summary, null, 2));
  console.log(`결과: ${relative(root, join(out, 'save-bench-result.json'))}`);
}
