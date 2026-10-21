// 저널 보유량 측정(D4, docs/m5-heap.md 5절). 한 쪽의 같은 문단을 N 번 편집·커밋하며 WASM 힙과 저널 보유 추정을 기록하고,
// 끝나면 예상 피크(planSave)·실제 저장 피크, 새 세션에 같은 로그를 재적용하는 시간을 잰다.
// 사용: node tools/bench/journal-child.mjs <pdf> <page> <N> [--no-save] [--no-replay]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PdfSession, wasmHeapBytes } from '../../packages/core/dist/index.js';

const FONT = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL('../../assets/fonts/NotoSansKR-Regular-subset.ttf', import.meta.url)),
  ),
);
const SCALE = 1.5;
const EVERY = 10;

const [path, pageArg, nArg] = process.argv.slice(2);
const page = Number(pageArg);
const n = Number(nArg);
const flags = new Set(process.argv.slice(5));
const bytes = new Uint8Array(readFileSync(path));
const out = { path, page, n, steps: [], ok: false };
const s = new PdfSession({ loadFallbackFont: async () => FONT });
s.open(bytes);
out.baseHeap = wasmHeapBytes();
s.renderPage({ pageIndex: page, scale: SCALE });
const ops = [];
const t0 = performance.now();
try {
  const ed = await s.getPageEditability(page);
  const para = ed.paragraphs.find((p) => p.editable);
  if (!para) throw new Error('편집 가능 문단 없음');
  out.paragraphId = para.paragraphId;
  for (let i = 0; i < n; i++) {
    // 편집 블록이 된 뒤에도 같은 문단 id 를 다시 찾는다(블록은 한 문단).
    const cur = (await s.getPageEditability(page)).paragraphs.find(
      (p) => p.editable && (i === 0 ? p.paragraphId === para.paragraphId : p.editedBlock !== null),
    );
    if (!cur) throw new Error(`${i}회: 편집할 문단을 다시 찾지 못함`);
    const plan = await s.planParagraphEdit(page, cur.paragraphId);
    const started = await s.beginParagraphEdit(page, cur.paragraphId, plan.revision);
    const base = plan.runs.map((r) => r.text).join('');
    await s.updateParagraphDraft(started.draftId, {
      runs: [{ text: `${base.replace(/ #\d+$/, '')} #${i + 1}`, style: plan.runs[0].style }],
      format: plan.format,
      composition: null,
      renderScale: SCALE,
    });
    const { op } = await s.commitParagraphEdit(started.draftId);
    ops.push(op);
    if ((i + 1) % EVERY === 0 || i === 0) {
      out.steps.push({
        edits: i + 1,
        heap: wasmHeapBytes(),
        // 엔진 내부 값: 세션 공개 경로(planSave)와 같은 값.
        journalBytes: s.planSave({ changes: [] }).heap.journalBytes ?? null,
        ms: performance.now() - t0,
      });
    }
  }
  out.editMs = performance.now() - t0;
  const plan = s.planSave({ changes: [] });
  out.plan = plan.heap;
  if (!flags.has('--no-save')) {
    const r = s.save({ changes: [] });
    out.savePeak = r.wasmHeapBytes;
    out.saveMs = r.saveMs;
  }
  out.ok = true;
} catch (e) {
  out.error = e instanceof Error ? e.message : String(e);
  out.failHeap = wasmHeapBytes();
  out.failAt = ops.length;
}
s.close();
if (!flags.has('--no-replay') && ops.length > 0) {
  // 재적용(D6 복구 경로): 새 세션에 열고 로그 전체를 적용하는 시간. 체크포인트 판단 기준(D4: 2 s).
  const r = new PdfSession({ loadFallbackFont: async () => FONT });
  r.open(bytes);
  const t1 = performance.now();
  try {
    await r.replayEdits(ops);
    out.replayMs = performance.now() - t1;
  } catch (e) {
    out.replayError = e instanceof Error ? e.message : String(e);
  }
  out.replayHeap = wasmHeapBytes();
}
process.stdout.write(`${JSON.stringify(out)}\n`);
