// Rerun on the real corpus (A7, docs/m0-corpus-recheck.md section 2). Called from cli.ts.
//
//   node scripts/corpus/fetch-corpus.mjs                     # download fixtures/corpus/*.pdf and verify hashes
//   pnpm --filter @pdf-editor/spike-m0 spike:corpus          # everything → out/m0-corpus/corpus-result.json
//   pnpm --filter @pdf-editor/spike-m0 spike:corpus -- --only kr-paper-1,us-report-1
//
// For each document, analysis (structure·paragraph selection) and editing (paragraph replacement·full save·reopen) each run in a separate Node process to
// separate the save-peak WASM heap per document. Edited result PDFs go to out/m0-corpus/edited/<id>.pdf.
import { openPdf, wasmHeapBytes } from '@pdf-editor/core';
import * as mupdf from 'mupdf';
import {
  HEAP_WARN_FRACTION,
  listXObjectUsages,
  parseContentOps,
  concatBytes,
  WASM_HEAP_LIMIT_BYTES,
  type HeapLevel,
} from '@pdf-editor/pdf-ops';
import type { Rect } from '@pdf-editor/shared-types';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeDocument,
  isMappingRisk,
  stripSubsetTag,
  type DocAnalysis,
} from './corpus-analyze.js';
import { runCorpusEdit, type CorpusEditResult, type ParagraphContext } from './corpus-edit.js';
import { rectsIntersect, selectParagraphs, type SelectionReport } from './corpus-select.js';
import { pickSharedTextForms, runFormUsageEdit, type FormEditResult } from './corpus-xobject.js';
import {
  compareWordsOutside,
  popplerRaster,
  popplerText,
  popplerVersion,
  popplerWords,
  ppmDiffStats,
} from './poppler.js';

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const squash = (s: string) => s.replace(/\s+/g, '');

export interface CorpusDoc {
  id: string;
  type: string;
  title: string;
  url: string;
  license: string;
  sha256: string;
  bytes: number;
  pages: number;
}

export interface CorpusManifest {
  documents: CorpusDoc[];
}

interface Mark {
  phase: string;
  tMs: number;
  wasmHeapBytes: number | null;
}

function marker(): { marks: Mark[]; mark: (phase: string) => void } {
  const start = performance.now();
  const marks: Mark[] = [];
  const mark = (phase: string) =>
    void marks.push({ phase, tMs: performance.now() - start, wasmHeapBytes: wasmHeapBytes() });
  mark('start');
  return { marks, mark };
}

export interface AnalyzeOutput {
  analysis: Omit<DocAnalysis, 'formTable' | 'fontTable' | 'textFormBoxes'>;
  selection: Omit<SelectionReport, 'selected'>;
  paragraphs: ParagraphContext[];
  marks: Mark[];
}

/** Child (analysis): structure analysis + paragraph selection + per-paragraph Form·tag·font context. Does not save. */
export function analyzeForEdit(bytes: Uint8Array, mark: (p: string) => void = () => {}) {
  const doc = openPdf(bytes);
  mark('open');
  const analysis = analyzeDocument(doc);
  mark('analyze');
  const selection = selectParagraphs(doc);
  mark('select');
  const tagged = analysis.tagged.structTreeRoot || analysis.tagged.markInfoMarked;
  const paragraphs: ParagraphContext[] = selection.selected.map((c) => {
    const page = doc.loadPage(c.pageIndex);
    const inv = mupdf.Matrix.invert(page.getTransform());
    page.destroy();
    const pdfRect = mupdf.Rect.transform(c.rect, inv);
    const pr: Rect = [pdfRect[0], pdfRect[1], pdfRect[2], pdfRect[3]];
    let formUsagesOnPage: number;
    try {
      formUsagesOnPage = listXObjectUsages(doc, c.pageIndex).filter(
        (u) => u.subtype === 'Form',
      ).length;
    } catch {
      formUsagesOnPage = -1;
    }
    const textFormsOverlapping = (analysis.textFormBoxes[c.pageIndex] ?? [])
      .filter((f) => rectsIntersect(f.box, pr))
      .map((f) => {
        const info = analysis.formTable[f.objectNumber]!;
        return {
          objectNumber: f.objectNumber,
          usages: info.usages,
          depth: f.depth,
          L1NoResources: info.noResources,
          L2StructParents: info.structParents,
          L6ParseError: info.parseError !== null,
          L7OptionalContent: info.optionalContent,
        };
      });
    let mcidOnPage: number;
    try {
      const contents = doc.findPage(c.pageIndex).get('Contents');
      const parts: Uint8Array[] = [];
      if (contents.isArray())
        contents.resolve().forEach((s) => void parts.push(s.readStream().asUint8Array().slice()));
      else if (!contents.isNull()) parts.push(contents.readStream().asUint8Array().slice());
      mcidOnPage = parseContentOps(concatBytes(parts, 0x0a)).filter(
        (o) =>
          (o.op === 'BDC' || o.op === 'BMC') &&
          o.operands.some((t) => t.kind === 'name' && t.value === 'MCID'),
      ).length;
    } catch {
      mcidOnPage = -1;
    }
    const names = new Set(c.fonts.map(stripSubsetTag));
    const fontMappingRisk = [
      ...new Set(
        analysis.fontTable
          .filter((f) => names.has(stripSubsetTag(f.baseFont)) && isMappingRisk(f))
          .map((f) => `${stripSubsetTag(f.baseFont)}(${f.subtype}/${f.encoding ?? '-'})`),
      ),
    ];
    return {
      ...c,
      formUsagesOnPage,
      textFormsOverlapping,
      mcidOnPage,
      tagged,
      fontMappingRisk,
    };
  });
  doc.destroy();
  const { formTable, fontTable, textFormBoxes, ...summary } = analysis;
  void formTable;
  void fontTable;
  void textFormBoxes;
  const { selected, ...sel } = selection;
  void selected;
  return { analysis: summary, selection: sel, paragraphs };
}

/** Child process entry point. */
export function runCorpusChild(
  task: string,
  input: string,
  plan: string | undefined,
  out: string,
  ttf: string,
  subsetFonts = true,
): void {
  const { marks, mark } = marker();
  const bytes = new Uint8Array(readFileSync(input));
  if (task === 'corpus-analyze') {
    const r = analyzeForEdit(bytes, mark);
    writeFileSync(out, JSON.stringify({ ...r, marks } satisfies AnalyzeOutput, null, 2));
    return;
  }
  if (task === 'corpus-edit') {
    const planned = JSON.parse(readFileSync(plan!, 'utf8')) as AnalyzeOutput;
    const r = runCorpusEdit({
      bytes,
      paragraphs: planned.paragraphs,
      fontBytes: new Uint8Array(readFileSync(ttf)),
      subsetFonts,
      onPhase: mark,
    });
    const { savedBytes, ...rest } = r;
    if (savedBytes) writeFileSync(out.replace(/\.json$/, '.pdf'), savedBytes);
    writeFileSync(
      out,
      JSON.stringify(
        {
          ...rest,
          savedSha256: savedBytes ? sha256(savedBytes) : null,
          marks,
          maxRssBytes: process.resourceUsage().maxRSS * 1024,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (task === 'corpus-xobject') {
    const doc = openPdf(bytes);
    const picks = pickSharedTextForms(doc);
    doc.destroy();
    const fontBytes = new Uint8Array(readFileSync(ttf));
    const forms = picks.map((f, i) => runFormUsageEdit(bytes, fontBytes, f.objectNumber, i + 1));
    writeFileSync(out, JSON.stringify({ forms }, null, 2));
    return;
  }
  throw new Error(`알 수 없는 작업: ${task}`);
}

type EditOutput = Omit<CorpusEditResult, 'savedBytes'> & {
  savedSha256: string | null;
  marks: Mark[];
  maxRssBytes: number;
};

const levelOf = (fraction: number): HeapLevel =>
  fraction > 1 ? 'over-limit' : fraction > HEAP_WARN_FRACTION ? 'warn' : 'ok';
const LEVEL_RANK: Record<HeapLevel, number> = { ok: 0, warn: 1, 'over-limit': 2 };

/** Poppler (independent implementation) cross-check: re-extraction·search terms·render diff outside the edit area·font table. */
function popplerCheck(original: string, saved: string, edit: EditOutput) {
  const fonts = spawnSync('pdffonts', [saved], { encoding: 'utf8' });
  const fontRow =
    fonts.stdout
      .split('\n')
      .find((l) => l.includes('NotoSansKR'))
      ?.trim() ?? null;
  // pdffonts columns: name type encoding emb sub uni object ID
  const cols = fontRow?.split(/\s+/) ?? [];
  const flags = cols.length >= 8 ? cols.slice(-5, -2) : [];
  const paragraphs = edit.paragraphs.map((p) => {
    if (!p.reopen || !p.layout) return null;
    const text = squash(popplerText(saved, p.pageIndex + 1));
    const scale = Math.min(
      2,
      2000 / Math.max(p.pageBounds[2] - p.pageBounds[0], p.pageBounds[3] - p.pageBounds[1]),
    );
    const dpi = Math.round(72 * scale);
    const s = dpi / 72;
    const ex: [number, number, number, number] = [
      Math.floor((p.exclusion[0] - p.pageBounds[0]) * s) - 2,
      Math.floor((p.exclusion[1] - p.pageBounds[1]) * s) - 2,
      Math.ceil((p.exclusion[2] - p.pageBounds[0]) * s) + 2,
      Math.ceil((p.exclusion[3] - p.pageBounds[1]) * s) + 2,
    ];
    const tmp = join(dirname(saved), `tmp-poppler-${process.pid}`);
    const a = popplerRaster(original, p.pageIndex + 1, `${tmp}-a`, dpi);
    const b = popplerRaster(saved, p.pageIndex + 1, `${tmp}-b`, dpi);
    const st = ppmDiffStats(a, b, ex);
    const exPt: [number, number, number, number] = [
      p.exclusion[0] - p.pageBounds[0],
      p.exclusion[1] - p.pageBounds[1],
      p.exclusion[2] - p.pageBounds[0],
      p.exclusion[3] - p.pageBounds[1],
    ];
    return {
      index: p.index,
      textFound: text.includes(squash(p.layout.text)),
      searchTermsFound: Object.fromEntries(p.searchTerms.map((t) => [t, text.includes(squash(t))])),
      outsidePx: st.differing,
      outsideStrongPx: st.strong,
      outsideMaxDelta: st.maxDelta,
      words: compareWordsOutside(
        popplerWords(original, p.pageIndex + 1),
        popplerWords(saved, p.pageIndex + 1),
        exPt,
      ),
      dpi,
    };
  });
  return {
    fontRow,
    embedded: flags[0] === 'yes',
    subset: flags[1] === 'yes',
    toUnicode: flags[2] === 'yes',
    paragraphs,
  };
}

export interface CorpusDocResult {
  id: string;
  type: string;
  title: string;
  license: string;
  bytes: number;
  pages: number;
  status: 'ok' | 'missing' | 'hash-mismatch' | 'analyze-failed' | 'edit-failed';
  error?: string;
  analyze?: AnalyzeOutput;
  edit?: EditOutput;
  poppler?: ReturnType<typeof popplerCheck>;
  heapCheck?: {
    predicted: HeapLevel;
    predictedFraction: number;
    actualBytes: number;
    actualFraction: number;
    actualLevel: HeapLevel;
    /** Predicted level ≥ actual level (not a miss) */
    noMiss: boolean;
    exact: boolean;
    actualRatio: number;
  };
  paragraphVerdicts?: {
    index: number;
    pageIndex: number;
    success: boolean;
    failures: string[];
    /** Observations not counted as failures (minor Poppler render differences, etc.) */
    notes: string[];
  }[];
  /** Clone·modify only one usage location of a shared Form that has text (M0 policy, A1-2). Only for documents that have such a Form */
  formEdits?: FormEditResult[];
  formEditError?: string;
}

function spawnTask(cli: string, args: string[]): { ok: boolean; stderr: string } {
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  return { ok: r.status === 0, stderr: (r.stderr ?? '').split('\n').slice(-8).join('\n') };
}

export function runCorpusCli(opts: {
  root: string;
  out: string;
  only: string[] | null;
  /** If false, a control run that skips subsetFonts() before saving (--no-subset) */
  subsetFonts?: boolean;
}): void {
  const { root, out } = opts;
  const manifest = JSON.parse(
    readFileSync(join(root, 'fixtures/corpus/manifest.json'), 'utf8'),
  ) as CorpusManifest;
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
  const editedDir = join(out, 'edited');
  mkdirSync(editedDir, { recursive: true });
  const poppler = popplerVersion();
  const results: CorpusDocResult[] = [];
  for (const d of manifest.documents) {
    if (opts.only && !opts.only.includes(d.id)) continue;
    const base = {
      id: d.id,
      type: d.type,
      title: d.title,
      license: d.license,
      bytes: d.bytes,
      pages: d.pages,
    };
    const pdf = join(root, 'fixtures/corpus', `${d.id}.pdf`);
    if (!existsSync(pdf)) {
      results.push({ ...base, status: 'missing' });
      continue;
    }
    if (sha256(readFileSync(pdf)) !== d.sha256) {
      results.push({ ...base, status: 'hash-mismatch' });
      continue;
    }
    const t0 = performance.now();
    const planFile = join(out, `${d.id}.analyze.json`);
    rmSync(planFile, { force: true });
    const a = spawnTask(cli, ['--child', 'corpus-analyze', '--input', pdf, '--out', planFile]);
    if (!a.ok || !existsSync(planFile)) {
      results.push({ ...base, status: 'analyze-failed', error: a.stderr });
      console.log(`${d.id}: 분석 실패\n${a.stderr}`);
      continue;
    }
    const analyze = JSON.parse(readFileSync(planFile, 'utf8')) as AnalyzeOutput;
    const editFile = join(editedDir, `${d.id}.json`);
    rmSync(editFile, { force: true });
    const e = spawnTask(cli, [
      '--child',
      'corpus-edit',
      '--input',
      pdf,
      '--plan',
      planFile,
      '--out',
      editFile,
      ...(opts.subsetFonts === false ? ['--no-subset'] : []),
    ]);
    if (!e.ok || !existsSync(editFile)) {
      results.push({ ...base, status: 'edit-failed', analyze, error: e.stderr });
      console.log(`${d.id}: 편집 실패\n${e.stderr}`);
      continue;
    }
    const edit = JSON.parse(readFileSync(editFile, 'utf8')) as EditOutput;
    const saved = editFile.replace(/\.json$/, '.pdf');
    const pop = poppler && existsSync(saved) ? popplerCheck(pdf, saved, edit) : undefined;

    let heapCheck: CorpusDocResult['heapCheck'];
    const heap = edit.save.heap;
    const actual = edit.save.wasmHeapAfterSaveBytes;
    if (heap && actual) {
      const actualFraction = actual / WASM_HEAP_LIMIT_BYTES;
      const actualLevel = levelOf(actualFraction);
      heapCheck = {
        predicted: heap.level,
        predictedFraction: heap.fraction,
        actualBytes: actual,
        actualFraction,
        actualLevel,
        noMiss: LEVEL_RANK[heap.level] >= LEVEL_RANK[actualLevel],
        exact: heap.level === actualLevel,
        actualRatio: actual / d.bytes,
      };
    }
    const paragraphVerdicts = edit.paragraphs.map((p) => {
      const failures = [...p.failures];
      const notes: string[] = [];
      const pp = pop?.paragraphs.find((x) => x?.index === p.index);
      if (pop && p.reopen) {
        if (!pp?.textFound) failures.push('poppler-text-missing');
        if (pp && Object.values(pp.searchTermsFound).some((v) => !v))
          failures.push('poppler-search-miss');
        if (!pop.embedded || !pop.subset || !pop.toUnicode) failures.push('poppler-font-flags');
        // Outside the edit area: fails if a word disappears or moves more than 0.5pt; smaller render differences are recorded as observations
        if (pp && pp.words.unmatched > 0) failures.push('poppler-word-lost');
        if (pp && pp.words.maxShiftPt > 0.5) failures.push('poppler-word-shift');
        if (pp && pp.words.maxShiftPt > 0.01) notes.push('poppler-word-subpt-shift');
        if (pp && pp.outsidePx !== 0) notes.push('poppler-raster-diff');
      }
      if (p.preSave && p.preSave.vsReferencePx > 0 && p.preSave.vsReferenceStrongPx === 0)
        notes.push('mupdf-glyph-aa-diff');
      if (p.redaction.outsidePx > 0 && p.redaction.outsideStrongPx === 0)
        notes.push('mupdf-outside-aa-diff');
      return {
        index: p.index,
        pageIndex: p.pageIndex,
        success: failures.length === 0,
        failures,
        notes,
      };
    });
    let formEdits: FormEditResult[] | undefined;
    let formEditError: string | undefined;
    if (analyze.analysis.forms.sharedWithText > 0) {
      const xFile = join(out, `${d.id}.xobject.json`);
      rmSync(xFile, { force: true });
      const x = spawnTask(cli, ['--child', 'corpus-xobject', '--input', pdf, '--out', xFile]);
      if (x.ok && existsSync(xFile))
        formEdits = (JSON.parse(readFileSync(xFile, 'utf8')) as { forms: FormEditResult[] }).forms;
      else formEditError = x.stderr;
    }
    results.push({
      ...base,
      status: 'ok',
      analyze,
      edit,
      poppler: pop,
      heapCheck,
      paragraphVerdicts,
      formEdits,
      formEditError,
    });
    console.log(
      `${d.id}: 문단 ${edit.paragraphs.length}개, 성공 ${paragraphVerdicts.filter((v) => v.success).length}, ` +
        `저장 ${edit.save.ok ? `${edit.save.saveMs.toFixed(0)} ms` : '실패'}, ` +
        `힙 ${actual ? (actual / 2 ** 20).toFixed(1) : '?'} MiB, ${(performance.now() - t0).toFixed(0)} ms`,
    );
  }
  const summary = summarize(results);
  writeFileSync(
    join(out, 'corpus-result.json'),
    JSON.stringify(
      { date: new Date().toISOString(), poppler, summary, documents: results },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(summary, null, 2));
  console.log(`결과: ${relative(root, join(out, 'corpus-result.json'))}`);
}

/** Aggregation by type: paragraph successes·failure reasons·restriction reasons·save-heap classification. */
export function summarize(results: CorpusDocResult[]) {
  const byType: Record<string, ReturnType<typeof emptyAgg>> = {};
  const total = emptyAgg();
  for (const r of results) {
    for (const agg of [(byType[r.type] ??= emptyAgg()), total]) {
      agg.docs++;
      if (r.status !== 'ok') {
        agg.docStatus[r.status] = (agg.docStatus[r.status] ?? 0) + 1;
        continue;
      }
      if (!r.edit || r.edit.paragraphs.length === 0) agg.docsWithoutParagraph++;
      for (const v of r.paragraphVerdicts ?? []) {
        agg.paragraphs++;
        if (v.success) agg.success++;
        for (const f of v.failures) agg.failures[f] = (agg.failures[f] ?? 0) + 1;
        for (const n of v.notes) agg.notes[n] = (agg.notes[n] ?? 0) + 1;
      }
      for (const p of r.edit?.paragraphs ?? []) {
        for (const code of new Set(p.restrictions.map((x) => `${x.code}:${x.level}`)))
          agg.restrictions[code] = (agg.restrictions[code] ?? 0) + 1;
        if (p.restrictions.some((x) => x.level === 'limit')) agg.paragraphsLimited++;
      }
      if (r.edit?.save.ok) agg.savesOk++;
      for (const f of r.formEdits ?? []) {
        agg.formEdits++;
        if (f.failures.length === 0) agg.formEditsOk++;
        for (const x of f.failures) agg.formEditFailures[x] = (agg.formEditFailures[x] ?? 0) + 1;
      }
      if (r.formEditError) agg.formEditErrors++;
      if (r.heapCheck) {
        agg.heap.checked++;
        if (r.heapCheck.noMiss) agg.heap.noMiss++;
        if (r.heapCheck.exact) agg.heap.exact++;
      }
    }
  }
  return { total, byType };
}

function emptyAgg() {
  return {
    docs: 0,
    docStatus: {} as Record<string, number>,
    docsWithoutParagraph: 0,
    paragraphs: 0,
    success: 0,
    paragraphsLimited: 0,
    failures: {} as Record<string, number>,
    notes: {} as Record<string, number>,
    restrictions: {} as Record<string, number>,
    savesOk: 0,
    heap: { checked: 0, noMiss: 0, exact: 0 },
    formEdits: 0,
    formEditsOk: 0,
    formEditErrors: 0,
    formEditFailures: {} as Record<string, number>,
  };
}
