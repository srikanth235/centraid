// @centraid/ui-core — framework-neutral UI logic shared by the desktop React
// shell (@centraid/desktop-ui) and the mobile RN app. No React, no DOM.
// Sits *on top of* @centraid/design-tokens (the pure-data leaf) and holds the
// view-models / helpers that both runtimes need but neither should own.

export { cx } from './cx.js';
export type { ClassValue } from './cx.js';

export { tileVisual } from './tile-visual.js';
export type { TileVisual } from './tile-visual.js';
