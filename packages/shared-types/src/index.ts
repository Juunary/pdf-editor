/**
 * Common types shared across packages and the Worker RPC contract.
 *
 * M1 contract (docs/m1-contract.md): extraction model, source link info, matching results, search, save classification, RPC.
 * Parallel implementations start from the commit that freezes this contract, and only the main session changes it (PLAN.md section 10).
 * M2 contract (docs/m2-contract.md): page layout (PageLayout, DocumentModel).
 * M3 contract (docs/m3-contract.md): paragraph editing (EditOp, edit plan, reflow summary, draft, undo).
 */
export * from './geometry.js';
export * from './page-model.js';
export * from './source-map.js';
export * from './search.js';
export * from './save.js';
export * from './page-layout.js';
export * from './edit.js';
export * from './rpc.js';
