// Border widths — the Binding Layer's one rule weight.
//
// The system draws exactly one kind of edge: the hairline. Tile borders,
// separators, control outlines, band edges, sheet rules — all of them are the
// same weight, because a second weight would be a second meaning nobody
// declared.

export const borders = {
  /**
   * The system rule, in device-independent units (CSS px on web, points on
   * native).
   *
   * A FULL unit. The v4 handoff draws every border and rule as
   * `border: 1px solid <token>`, and native must match it: React Native's
   * `StyleSheet.hairlineWidth` is one PHYSICAL pixel, which on a 3× phone is
   * 0.33pt — a third of the specified edge. Surfaces in this system sit only a
   * few percent off the page by design, so the edge does most of the work of
   * making a plate read as a plate; at a third strength the plate looked
   * missing rather than subtle. Native call sites therefore use this token and
   * never `StyleSheet.hairlineWidth` — enforced by `scripts/lint-hairline.mjs`.
   */
  hairline: 1,
} as const;

export type BorderKey = keyof typeof borders;
