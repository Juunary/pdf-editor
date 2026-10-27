/**
 * Viewer UI (PLAN.md section 4): Preact + overlays.
 *
 * M1 scope (docs/m1-contract.md 5.3): page navigation, text selection layer, Ctrl+F search UI, debug overlay.
 * M3 scope (docs/m3-contract.md 5.9): paragraph editor (edit model, session, coordinator, edit layer).
 * M4 scope (docs/m4-contract.md 4.5): cell and vector path editing, editability overlay, table grid (merged cells), input buffer.
 * This file exports the pure functions (layout, reading order, search/page navigation, debug display, edit model, geometry) and the controller.
 */
export * from './layout.js';
export * from './text-layout.js';
export * from './reading-order.js';
export * from './page-nav.js';
export * from './search-nav.js';
export * from './debug-info.js';
export * from './failure.js';
export * from './viewer-host.js';
export * from './shortcuts.js';
export * from './controller.js';
export * from './render-cache.js';
export * from './selection-dom.js';
export * from './selection-rects.js';
export * from './text-measure.js';
export * from './mount.js';
export * from './edit-text.js';
export * from './edit-model.js';
export * from './edit-geometry.js';
export * from './edit-keys.js';
export * from './edit-paint.js';
export * from './edit-labels.js';
export * from './edit-log.js';
export * from './edit-session.js';
export * from './edit-controller.js';
export * from './path-geometry.js';
export * from './path-gesture.js';
export * from './path-controller.js';
export * from './path-colors.js';
export * from './input-buffer.js';
export * from './edit-marks.js';
export * from './table-grid.js';
export * from './strings.js';
export * from './error-text.js';
