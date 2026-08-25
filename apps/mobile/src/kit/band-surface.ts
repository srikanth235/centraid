// The band's PLATE (invariant 1): one definition, so the two bands cannot drift.

import { borders } from "@centraid/design";

export const BAND_INSET = 12;
export const BAND_TOP_GAP = 8;
export const BAND_RADIUS = 12;
export const BAND_BORDER = borders.hairline;
export const BAND_TAB_MIN_HEIGHT = 52;

/** The ONLY carrier of selection besides ink colour; weight cannot mark it. */
export const BAND_ACTIVE_RULE = 2;
export const BAND_ACTIVE_RULE_INSET = 14;

/** A floor, not a reserve: the band is a flex SIBLING, so nothing subtracts it. */
export const BAND_HEIGHT =
  BAND_TOP_GAP + BAND_TAB_MIN_HEIGHT + 2 * BAND_BORDER + BAND_INSET;

export interface BandSurfaceStyle {
  backgroundColor: string;
  borderColor: string;
  borderWidth: number;
  borderRadius: number;
  marginHorizontal: number;
  marginBottom: number;
  marginTop: number;
}

/** `page` must be OPAQUE — no blur, tint or shadow. */
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
    marginTop: BAND_TOP_GAP,
  };
}

export function isOpaqueColor(value: string): boolean {
  if (/^rgba?\(/iu.test(value)) {
    // Number() refuses the trailing paren that parseFloat forgave.
    const alpha = value.split(",")[3]?.replace(")", "").trim();
    return alpha === undefined || Number(alpha) === 1;
  }
  if (value === "transparent") return false;
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
