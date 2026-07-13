import type { JSX } from 'react';
import { icons } from '@centraid/design-tokens';
import type { IconName } from '@centraid/design-tokens';

export interface IconProps {
  name: IconName;
  size?: number;
  /**
   * Stroke/fill color. Defaults to `currentColor` so the glyph inherits the
   * surrounding CSS `color` — matching the vanilla renderer's `Icon[name]()`
   * output exactly. Mobile passes an explicit color; on the web we lean on
   * inheritance.
   */
  color?: string;
  strokeWidth?: number;
}

/**
 * Line icon, mirroring the mobile `<Icon>` API. Path data is the single
 * source of truth in @centraid/design-tokens, so desktop + mobile draw the
 * same glyphs. Emits the identical SVG shape the vanilla `icons.ts` wrapper
 * produces, so a React-drawn icon and a leftover vanilla one are pixel-equal.
 */
export default function Icon({
  name,
  size = 20,
  color = 'currentColor',
  strokeWidth = 1.5,
}: IconProps): JSX.Element | null {
  const paths = icons[name];
  if (!paths) {
    return null;
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths.map((p, i) =>
        p.fill === 'currentColor' ? (
          <path key={i} d={p.d} fill={color} stroke="none" />
        ) : (
          <path key={i} d={p.d} />
        ),
      )}
    </svg>
  );
}
