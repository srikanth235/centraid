// The band's PLATE — the Binding Layer's invariant 1, as code.
//
// This lives in the kit, not in an app, because the band belongs to the FRAME.
// What the two bands share is the PLATE: a 12-radius rectangle with a 1pt
// `lineStrong` edge on an opaque `bgElev` ground, held 12pt off the side and
// bottom edges of the stage and 8pt clear of the content above it. When this
// lived under `apps/photos/`, the claimed band floated and Home's band was a
// flush edge-to-edge bar with a top rule — two bands, visibly different, which
// is exactly what invariant 1 forbids. One definition, imported by both, makes
// that drift unrepresentable.
//
// The two bands COMPOSE that plate differently, and the handoff is explicit
// about it:
//
//   - The FRAME's band (Home, `mobileBandStyle` :5961-5963) is ONE plate. The
//     tabs sit directly inside it, behind `padding:0 4px`.
//   - A CLAIMED band (Photos, `appBandStyle` :4955-4964) is TWO plates inside a
//     TRANSPARENT row: the frame's capsule (`bandCapsuleStyle` :4961-4963 —
//     `flex:none`, 52 wide, on the frame's NEUTRAL page colour, never the app's
//     mat) and the app's tab group (`appBandGroupStyle` :4959-4960 — `flex:1`,
//     on `t.surf`, `padding:0 2px`, `gap:2px`). The gap between them IS the
//     group boundary, which is the whole explanation for why the capsule is not
//     a sixth tab. The transparent row carries the inset; each plate carries its
//     own radius, edge and ground.
//
// So this function states the PLATE, and the claimed band applies the inset on
// its transparent container instead of on either plate.
//
// Plain data, no `react-native` import: the rules below stay assertable without
// a renderer.

import { borders } from "@centraid/design";

/** The gap between the band and the screen edges, on all three sides. */
export const BAND_INSET = 12;
/** The gap between the band and the content above it (:5961's `margin` top and
 *  :4955-4956's `padding` top are both `R.gap.s` = 8). */
export const BAND_TOP_GAP = 8;
/** The band's corner radius. */
export const BAND_RADIUS = 12;
/** The band's edge — the system rule, like every other edge in the app. */
export const BAND_BORDER = borders.hairline;
/** A destination's own minimum height inside the plate (:4970-4972). */
export const BAND_TAB_MIN_HEIGHT = 52;

/**
 * How much vertical room a band occupies, before the home-indicator inset.
 *
 * The band's own floor, derived from its parts rather than typed as a number:
 * top gap + tallest tab + both edges + the bottom inset. It is a floor, not a
 * reserve — no scroll surface subtracts it any more. A band is a FLEX SIBLING
 * of the content slot (handoff `appBandStyle` :4955 — `flex:none` below the
 * scroll region), so the viewport is short by the band's real measured height
 * and nothing can pass under it. The predecessor of that rule was a reserve
 * padded onto every scroll surface, which cleared only the END of the content:
 * mid-scroll, day headers and captions still ran under the bar.
 */
export const BAND_HEIGHT =
  BAND_TOP_GAP + BAND_TAB_MIN_HEIGHT + 2 * BAND_BORDER + BAND_INSET;

/** A minimal structural style record — plain data, so this module stays free
 *  of `react-native` and the rules below can be asserted without a renderer. */
export interface BandSurfaceStyle {
  backgroundColor: string;
  borderColor: string;
  borderWidth: number;
  borderRadius: number;
  marginHorizontal: number;
  marginBottom: number;
  marginTop: number;
}

/**
 * §G, as code — the PLATE, not the whole band. Callers that draw one plate
 * (Home) spread this on the band itself; callers that draw two (Photos) put the
 * inset on their transparent row and give each plate its own ground.
 *
 * The band's ground is the surface's own OPAQUE page colour: no blur, no tint
 * film, no sheen, and — the part that keeps being re-added —
 * no shadow or elevation. The bar sits over unpredictable content, so label
 * contrast, the active bar and the focus ring must not depend on what the
 * member photographed; and `prefers-reduced-transparency` would need the
 * opaque bar anyway, so glass would mean maintaining two bands.
 *
 * `page` must be an opaque colour. Passing an `rgba()`/`transparent` value is
 * the exact regression this function exists to make visible.
 */
export function bandSurfaceStyle(
  page: string,
  line: string,
  hairline: number
): BandSurfaceStyle {
  return {
    backgroundColor: page,
    borderColor: line,
    borderWidth: hairline,
    borderRadius: BAND_RADIUS,
    marginBottom: BAND_INSET,
    marginHorizontal: BAND_INSET,
    // The fourth side. The handoff's frame band is `margin:8px 12px 12px`
    // (:5961) and the claimed band's container is `padding:8px 12px 12px`
    // (:4955-4956) — the top gap is 8, not 0, on both. This was missing, so the
    // band sat flush against whatever the last row of content was.
    marginTop: BAND_TOP_GAP,
  };
}

/** Whether a colour value is opaque — the band's ground has to be. */
export function isOpaqueColor(value: string): boolean {
  if (/^rgba?\(/iu.test(value)) {
    // The fourth comma-field still carries the closing paren ("0.5)") — strip
    // it before coercing, since Number() refuses what parseFloat forgave.
    const alpha = value.split(",")[3]?.replace(")", "").trim();
    return alpha === undefined || Number(alpha) === 1;
  }
  if (value === "transparent") return false;
  // #RGBA and #RRGGBBAA carry an alpha channel; #RGB and #RRGGBB do not.
  if (/^#(?<withAlpha>[0-9a-f]{4}|[0-9a-f]{8})$/iu.test(value)) {
    const digits = value.slice(1);
    const alpha =
      digits.length === 4
        ? Number.parseInt(digits[3]!.repeat(2), 16)
        : Number.parseInt(digits.slice(6), 16);
    return alpha === 255;
  }
  return true;
}
