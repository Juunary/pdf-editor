// 저장 힙 측정 1회(docs/m5-heap.md 2절). 측정마다 새 Node 프로세스: WASM 선형 메모리는 줄지 않아 저장 직후 값이 피크다.
// 사용: node tools/bench/heap-child.mjs <pdf> <full|none|full2|none2> [보기 쪽 수]
//   full: 첫 편집 가능 문단에 한글을 덧붙여 커밋(폴백 폰트 임베딩) → planSave → save(전체 저장)
//   none: 편집 없이 planSave → save(변경 없음, 증분 저장)
//   full2·none2: 같은 세션 저장 2회(docs/m5-heap.md 4.4). 첫 저장 뒤 (full2 는 다시 편집하고) 다음 N 쪽을 더 렌더한 다음
//     planSave → save. 결과의 plan2·peak2 가 두 번째 저장이다.
//   보기 쪽 수(기본 0): 저장 전에 앞쪽 N 쪽을 더 렌더한다(사용자가 넘겨 본 상태, 힙 이력이 피크 계단을 바꾼다).
// 결과 JSON 한 줄을 stdout 에 쓴다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// core 를 mupdf 보다 먼저 불러야 WASM 힙 측정 객체가 연결된다(packages/core/src/wasm-module.ts).
import { PdfSession, wasmHeapBytes } from '../../packages/core/dist/index.js';

const FONT = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL('../../assets/fonts/NotoSansKR-Regular-subset.ttf', import.meta.url)),
  ),
);
/** 편집 문단을 찾아볼 앞쪽 수. */
const EDIT_SEARCH_PAGES = 8;
const RENDER_SCALE = 1.5;

export async function measure(path, variant, viewPages = 0) {
  const out = { path, variant, viewPages, ok: false, marks: {} };
  const mark = (name) => (out.marks[name] = wasmHeapBytes());
  try {
    const bytes = new Uint8Array(readFileSync(path));
    out.inputBytes = bytes.byteLength;
    const s = new PdfSession({ loadFallbackFont: async () => FONT });
    const opened = s.open(bytes);
    out.pages = opened.pageCount;
    out.openMs = opened.openMs;
    mark('open');
    s.renderPage({ pageIndex: 0, scale: RENDER_SCALE });
    mark('render');
    const t0 = performance.now();
    out.stats = s.documentStats();
    out.statsMs = performance.now() - t0;
    mark('stats');
    const editOnce = async (suffix) => {
      for (let p = 0; p < Math.min(EDIT_SEARCH_PAGES, opened.pageCount); p++) {
        const ed = await s.getPageEditability(p);
        for (const para of ed.paragraphs.filter((x) => x.editable)) {
          const plan = await s.planParagraphEdit(p, para.paragraphId);
          if (!plan.editable) continue;
          const started = await s.beginParagraphEdit(p, para.paragraphId, plan.revision);
          const text = plan.runs.map((r) => r.text).join('') + suffix;
          await s.updateParagraphDraft(started.draftId, {
            runs: [{ text, style: plan.runs[0].style }],
            format: plan.format,
            composition: null,
            renderScale: RENDER_SCALE,
          });
          await s.commitParagraphEdit(started.draftId);
          return { page: p, paragraphId: para.paragraphId };
        }
      }
      return null;
    };
    const edits = variant === 'full' || variant === 'full2';
    if (edits) {
      out.edit = await editOnce(' 수정 확인');
      mark('edit');
    }
    for (let p = 1; p <= Math.min(viewPages, opened.pageCount - 1); p++) {
      s.renderPage({ pageIndex: p, scale: RENDER_SCALE });
    }
    if (viewPages > 0) mark('view');
    const plan = s.planSave({ changes: [] });
    out.plan = { method: plan.method, heap: plan.heap };
    mark('plan');
    const res = s.save({ changes: [] });
    out.method = res.method;
    out.saveMs = res.saveMs;
    out.outputBytes = res.bytes.byteLength;
    out.peak = res.wasmHeapBytes;
    mark('save');
    if (variant === 'full2' || variant === 'none2') {
      if (edits) {
        out.edit2 = await editOnce(' 두 번째');
        mark('edit2');
      }
      const last = Math.min(2 * viewPages, opened.pageCount - 1);
      for (let p = viewPages + 1; p <= last; p++) {
        s.renderPage({ pageIndex: p, scale: RENDER_SCALE });
      }
      if (viewPages > 0) mark('view2');
      const plan2 = s.planSave({ changes: [] });
      out.plan2 = { method: plan2.method, heap: plan2.heap };
      mark('plan2');
      const res2 = s.save({ changes: [] });
      out.method2 = res2.method;
      out.saveMs2 = res2.saveMs;
      out.peak2 = res2.wasmHeapBytes;
      mark('save2');
    }
    out.ok = true;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    mark('error');
  }
  out.maxRssBytes = process.resourceUsage().maxRSS * 1024;
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [path, variant = 'full', view = '0'] = process.argv.slice(2);
  const r = await measure(path, variant, Number(view));
  process.stdout.write(`${JSON.stringify(r)}\n`);
}
