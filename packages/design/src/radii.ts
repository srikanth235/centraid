// Radii — the Binding Layer's four shapes.
//
// The system has exactly three static radii plus the pill: content is square
// (0), a control is 7px, a container is 12px, and an identity mark is a
// PERCENTAGE of its own size (26%), which no static custom property can carry —
// see `iconChipRadius()`.
//
// Each shape has one public name. The old `xl` alias resolved to the same 12px
// value as `lg`; keeping both made callers choose between synonyms for the one
// container shape, so it was removed. `sm` is the only value outside the
// brief's primary set — a 4px
// half-rung kept for details nested INSIDE a control (a swatch, a checkbox
// tick well), where the control's own 7px would read as a second container.

export const radii = {
  /** Content. Images, thumbnails, media, code — square, always. */
  xs: 0,
  /** The one sub-control rung, for details nested inside a 7px control. */
  sm: 4,
  /** Controls: buttons, fields, chips-as-controls, segmented items. */
  md: 7,
  /** Containers: cards, panels, sheets, dialogs. */
  lg: 12,
  /** Fully round — avatars and switch tracks only. */
  pill: 999,
} as const;

export type RadiusKey = keyof typeof radii;

/** An app icon container is a rounded square whose radius is a share of its
 *  own size, so the silhouette holds at 14px and at 30px. CSS could express
 *  this as `border-radius: 26%`, React Native cannot, and no static token can
 *  either — so it is a function of the size the caller is drawing at. */
export const ICON_CHIP_RADIUS_RATIO = 0.26;

/** The icon-container radius, in px, for a chip drawn at `size` px. */
export function iconChipRadius(size: number): number {
  return Math.round(size * ICON_CHIP_RADIUS_RATIO * 100) / 100;
}
