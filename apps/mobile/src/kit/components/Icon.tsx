import React from "react";
import Svg, { Path } from "react-native-svg";

import { icons } from "@centraid/design";
import type { IconName } from "@centraid/design";

import { useTheme } from "../theme";
import { resolveIconFill } from "./icon-fill";
import { resolveIconName } from "./icon-resolver";
import { resolveStrokeWidth } from "./icon-stroke-width";

export interface IconProps {
  name: IconName | string;
  size?: number;
  color?: string;
  strokeWidth?: number;
  /** Solid in the same ink, for a filled-vs-unfilled state (a starred row).
   *  Off by default — see ./icon-fill.ts. */
  fill?: boolean;
}

// Set drawn for round caps and joins; the caller sets stroke-width — 1.6
// normally, 1.75 below 16px (packages/design/src/icons.ts header comment).
// `strokeWidth` stays available as an explicit override for the few
// deliberately non-standard glyphs (illustration, debossed treatments). See
// ./icon-stroke-width.ts for the rule itself.

export default function Icon({
  name,
  size = 20,
  color,
  strokeWidth,
  fill = false,
}: IconProps): React.JSX.Element | null {
  const { colors } = useTheme();
  const paths = icons[resolveIconName(name)];
  const resolvedColor = color ?? colors.text;
  const resolvedStrokeWidth = resolveStrokeWidth(size, strokeWidth, paths);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {paths.map((p, i) => (
        <Path
          key={i}
          d={p.d}
          stroke={resolvedColor}
          strokeWidth={resolvedStrokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill={resolveIconFill(resolvedColor, fill, p.fill)}
        />
      ))}
    </Svg>
  );
}
