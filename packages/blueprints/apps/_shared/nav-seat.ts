// Exactly one navigation for one set of destinations. Photos/Docs destinations
// live on band, strip, or rail — never none and never two.
//
// Read BOTH signals: `narrow` is the APP PANE's width (inline, a pane can be
// much narrower than the viewport); `compact` is the SHELL's form factor, the
// only thing that honours a band claim. Pane-only once dropped the strip on a
// pane the shell did not consider compact: no strip, no band, nowhere to go.

/** `band` claimed compact slots; `strip` tabs without a column; `rail` 232px pointer. */
export type NavSeat = "band" | "strip" | "rail";

export function navSeat({
  narrow,
  compact,
}: {
  /** The APP PANE is narrow — this app's element, never the viewport. */
  narrow: boolean;
  /** SHELL form factor. Band claims are honoured only here. */
  compact: boolean;
}): NavSeat {
  // Band claim honoured: the frame already draws these destinations.
  if (compact && narrow) return "band";
  // Pointer seat with room for a column. 232px beside a 390px pane is not one.
  if (!compact && !narrow) return "rail";
  return "strip";
}
