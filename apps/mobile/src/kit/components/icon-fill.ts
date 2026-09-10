// Whether a glyph is drawn filled, split out of `Icon.tsx` for the same reason
// as `icon-stroke-width.ts`: no react-native-svg / theme import, so
// `Icon.test.tsx` can assert the rule in the node tier.

/**
 * ONE TONE (#1015): a filled glyph is filled in the ink it is stroked in —
 * there is no second fill colour anywhere in the system, so `fill` is a
 * boolean, not a colour. Filled-vs-unfilled is the ICON's contract: an app
 * that wants a solid star asks for one here instead of hand-rolling an `Svg`
 * whose weight and path then drift from the registry.
 *
 * Two defaults keep every existing glyph exactly where it was: `fill` is off,
 * and a path that already declares `fill: "currentColor"` in the registry
 * (`Compass`'s needle) still fills without being asked.
 */
export function resolveIconFill(
  color: string,
  fill: boolean,
  pathFill?: string
): string {
  return fill || pathFill === "currentColor" ? color : "none";
}
