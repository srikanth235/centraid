// Shared library/gallery chrome — the <rect>-based glyphs the path-only Icon
// set can't express, plus the Tiles|Rows layout toggle that Home (app.ts) and
// Discover (app-discover.ts) both render. Single source of truth so the glyphs
// and toggle behaviour can't drift between the two pages.

const rectSvg = (rects: string, size: number, sw = 1.75): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${rects}</svg>`;

const GRID_RECTS =
  '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/>' +
  '<rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/>' +
  '<rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/>' +
  '<rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>';

const ROWS_RECTS =
  '<rect x="3.5" y="4.5" width="17" height="6" rx="1.5"/>' +
  '<rect x="3.5" y="13.5" width="17" height="6" rx="1.5"/>';

/** Layout-toggle "Tiles" glyph — a 2×2 tile grid. */
export const TILES_SVG = rectSvg(GRID_RECTS, 15);
/** Layout-toggle "Rows" glyph — two stacked bars. */
export const ROWS_SVG = rectSvg(ROWS_RECTS, 15);
/** Footer APP kind-badge glyph — the same 2×2 grid, badge-sized. */
export const APP_BADGE_SVG = rectSvg(GRID_RECTS, 12, 1.85);

export type LibLayout = 'tiles' | 'rows';

// Tiles|Rows segmented toggle. `getCurrent` reads the caller's session layout
// state; `onPick` mutates it and repaints. The toggle owns its own aria-pressed
// sync, so callers just append the returned element.
export function buildLayoutToggle(
  el: ElHelper,
  getCurrent: () => LibLayout,
  onPick: (mode: LibLayout) => void,
): HTMLElement {
  const toggle = el('div', { class: 'cd-lib-layout', role: 'group', 'aria-label': 'Layout' });
  const sync = (): void => {
    for (const btn of toggle.querySelectorAll<HTMLElement>('.cd-lib-layout-btn'))
      btn.setAttribute('aria-pressed', String(btn.dataset.layout === getCurrent()));
  };
  const mk = (mode: LibLayout, label: string, glyph: string): HTMLElement =>
    el('button', {
      class: 'cd-lib-layout-btn',
      type: 'button',
      title: label,
      'aria-label': label,
      'aria-pressed': String(mode === getCurrent()),
      'data-layout': mode,
      trustedHtml: glyph,
      onClick: () => {
        if (getCurrent() === mode) return;
        onPick(mode);
        sync();
      },
    });
  toggle.append(mk('tiles', 'Tiles', TILES_SVG), mk('rows', 'Rows', ROWS_SVG));
  return toggle;
}
