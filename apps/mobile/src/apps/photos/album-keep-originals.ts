// What the album's "Keep originals on device" row SAYS. Pure, so the claim is
// assertable without a renderer.
//
// The sub-line used to be the constant "Excluded from Free up vault", which is
// a live-status shape printing a fact that is false whenever the switch is off
// — and off is the default. It now derives from the switch, and says nothing at
// all until the pin store has hydrated: a claim about what Free up vault will
// reclaim is not one to guess at.

export function keepOriginalsMeta(input: {
  keepOriginals: boolean;
  pinsReady: boolean;
}): string {
  if (!input.pinsReady) return "Checking this album's originals";
  return input.keepOriginals
    ? "Excluded from Free up vault"
    : "Included in Free up vault";
}
