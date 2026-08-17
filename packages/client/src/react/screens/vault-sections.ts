// The Vault surface's three disclosures (v11) — which of them start open.
//
// Pointer and touch answer this differently, and the reason is geometry rather
// than preference. On a desktop canvas all three sections and their rows fit
// above the fold of one scroll, so opening them costs a member nothing and
// closing them by hand is the rarer act. On a phone, "What it holds" alone is
// forty rows: a page that opened all three would put "Where it lives" — the
// half a member reached for when they went looking for a device — six screens
// down, and the section head's Show verb is the only way back up.
//
// This is the ONE `matchMedia` in the surface. Surface is the one fixed row in
// DESIGN.md's freedom table and it has exactly one axis, pointer or touch, so
// the query is `(pointer: fine)` and never a width: a narrow window on a laptop
// is a canvas, not a second surface, and it keeps the pointer's answer.

/** The media query the surface axis is actually made of. */
const POINTER = "(pointer: fine)";

/**
 * Do the three sections start closed?
 *
 * Open wherever the question cannot be asked — SSR, jsdom, an old engine with
 * no `matchMedia`. A page that defaulted to closed when it could not tell would
 * hide its whole body from every reader it failed to measure, and an open
 * section is recoverable by one press where a hidden one has to be discovered.
 */
export function sectionsStartCollapsed(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return !window.matchMedia(POINTER).matches;
  } catch {
    return false;
  }
}
