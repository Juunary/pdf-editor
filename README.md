# pdf-editor

PDF editor with paragraph reflow, table-cell and vector-path editing. Chrome extension (MV3); the core is TypeScript + MuPDF WebAssembly (npm `mupdf`). License: AGPL-3.0-or-later.

Features: open PDFs, select and copy text, search the document, edit paragraphs (reflow, Korean IME input), edit table-cell text, edit vector paths (move, resize, points, colour, stroke width, delete), undo/redo, editability overlay, save. The UI follows the browser language (Korean or English).

## Running

```bash
corepack enable pnpm   # pnpm 11.28.6 (package.json packageManager), Node 22.13 or later
pnpm install
pnpm build             # produces apps/extension/dist
pnpm test              # Vitest + Playwright (bundled Chromium)
pnpm lint
pnpm exec prettier --check .
```

Before the first e2e run: `pnpm --filter @pdf-editor/extension exec playwright install chromium`.

Load into Chrome: `chrome://extensions` → Developer mode → "Load unpacked" → `apps/extension/dist`. Installation and usage details (Korean): [docs/user](docs/user/README.md).

Web Store package: `pnpm --filter @pdf-editor/extension package` → `apps/extension/out/release/`. Procedure: [docs/release.md](docs/release.md).

## Structure

| Path | Contents |
| --- | --- |
| `packages/shared-types` | Shared types, Worker RPC contract |
| `packages/core` | MuPDF lifecycle and document state, rendering, edit engine, Worker RPC (Comlink) |
| `packages/pdf-ops` | Content-stream interpreter (SourceMap), text and path edit writers, font embedding, save strategy |
| `packages/layout-recon` | Page model → paragraphs, columns, tables, figures, reading order |
| `packages/reflow` | Shaping and line layout |
| `packages/viewer-ui` | Preact viewer: selection layer, search, editors, path editing, editability overlay |
| `apps/extension` | MV3 shell: manifest, service worker, viewer, Worker, save adapters |
| `assets/fonts` | Fallback font (Noto Sans KR subset TTF, OFL-1.1) |
| `fixtures` | Corpus manifest, accuracy labels, benchmark manifest |
| `docs` | User docs (`docs/user`), store listing material (`docs/store`), contracts and work records (Korean) |

Architecture and data flow: [docs/architecture.md](docs/architecture.md).

## Results

| Item | Value | Source |
| --- | --- | --- |
| Corpus edits, 330 (paragraphs), render change outside the edit area 0 px | MuPDF, pdf.js, Poppler 330/330 each | `docs/m4-integration.md` 4.1 |
| Table-cell edits, 63, render change outside the area 0 px | 63/63 on all three engines | same document 4.2 |
| Path edits, 60, render change outside the area 0 px | 60/60 on all three engines | same document 4.2 |
| Reapply determinism (reapply in a new session = original) | cells 63/63, paths 60/60 | same document 4.2 |
| Layout reconstruction (test2, 14 labelled pages) | paragraph F1 0.881, table P/R 1.0 | `docs/m2-accuracy.md` |
| Path drag update (largest path page in the corpus, server) | p95 89.3 ms (scale 2) | `docs/m4-integration.md` 4.3 |
| Windows reference PC (Chrome 155, Core Ultra 5 228V, 7 documents) | open p95 46–1,055 ms, page turn p95 45–287 ms, save p95 66–494 ms | `docs/m5-integration.md` 9.2 |
| Unit tests | shared-types 4, layout-recon 60, reflow 60, pdf-ops 457, core 308, viewer-ui 331, extension 119, spike-m0 33 (1,372 passed, 16 skipped) | `docs/release-1.0.0.md` |
| e2e | 191 passed, 6 skipped (opt-in) | same document |

Numbers other than the Windows row are measured on the server (Linux, Node 22, Playwright bundled Chromium).

## Limitations

- One page at a time (no continuous scrolling).
- Paragraphs, cells and paths with an edit restriction cannot be edited: vertical text, Type3 fonts, clipped text, OCR layers, pattern fills, etc. List: [docs/user/limits.md](docs/user/limits.md).
- Not supported: adding rows/columns, merging/splitting cells, drawing new paths, editing image content, forms and signatures, OCR.
- Edited documents are saved in full. Because of the WASM heap limit (2 GiB), large documents get a warning or are stopped before saving.
- Known issues in 1.0.0 (measured on the Windows reference PC): edit response on some image-heavy pages exceeds the 100 ms target (median 118 ms on one document); tab memory after long editing sessions on large pages exceeds the 150 MiB target; documents over 100 MB have not been verified. Details: `docs/m5-integration.md` 9.2.
- The Web Store build requires Chrome 151 or later. Chrome 128–150 is a limited path in the development/legacy build.
