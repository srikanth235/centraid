// WHICH SURFACE CARRIES AN APP'S OWN DESTINATIONS — one function, three
// answers, and never two at once.
//
// Photos and Docs each have more than four destinations of their own, so each
// draws them in one of three places depending on the seat. EXACTLY ONE
// NAVIGATION FOR ONE SET OF DESTINATIONS is the rule, and it lives here rather
// than as a condition inside each render function, so a seat that draws none
// (a destination reachable from nowhere) and a seat that draws two (one place
// named twice) are both impossible rather than merely unobserved.
//
// BOTH SIGNALS ARE READ, and the reason is a bug this repo already had: a
// layout signal may hide a navigation only where it knows the replacement
// rendered. `narrow` is the APP PANE's own width — inline, a pane can be much
// narrower than the viewport — and `compact` is the SHELL's form factor, which
// is the only thing the shell honours a band claim on. Reading the pane alone
// once dropped the strip on a pane the shell did not consider compact: no
// strip, no band, and every shelf reachable from nowhere.

/**
 * The three surfaces, in the order a widening seat hands off between them.
 *
 *   * `band` — the frame's compact navigation band, which the app has claimed
 *     and the shell has honoured. Its own six slots carry the destinations.
 *   * `strip` — the horizontal shelf strip under the app bar. The form the
 *     spine takes where there is width for a row of tabs but not for a column
 *     beside the set.
 *   * `rail` — the 232px vertical rail on the leading edge of the content
 *     (v16). A pointer seat only.
 */
export type NavSeat = "band" | "strip" | "rail";

export function navSeat({
  narrow,
  compact,
}: {
  /** The APP PANE is narrow — this app's own element, never the viewport. */
  narrow: boolean;
  /** The SHELL's form factor is compact. The only surface on which a band
   *  claim is honoured. */
  compact: boolean;
}): NavSeat {
  // The band claim was honoured, so the frame is already drawing these
  // destinations and the app draws none of them itself.
  if (compact && narrow) return "band";
  // A pointer seat with room for a column beside the set. 232px beside a 390px
  // pane is not a column, which is why the pane's own width is half of this.
  if (!compact && !narrow) return "rail";
  // Everything between: a wide pane on a compact shell, or a narrow pane on a
  // pointer one. The strip is the form of the spine that fits both.
  return "strip";
}
