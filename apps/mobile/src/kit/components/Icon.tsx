import React from "react";
import Svg, { Path } from "react-native-svg";

import { icons } from "@centraid/design";
import type { IconName } from "@centraid/design";

import { useTheme } from "../theme";
import { resolveIconName } from "./icon-resolver";

export interface IconProps {
  name: IconName | string;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

export default function Icon({
  name,
  size = 20,
  color,
}: IconProps): React.JSX.Element | null {
  const { colors } = useTheme();
  const paths = icons[resolveIconName(name)];
  const resolvedColor = color ?? colors.text;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {paths.map((p, i) => (
        <Path
          key={i}
          d={p.d}
          stroke={resolvedColor}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill={p.fill === "currentColor" ? resolvedColor : "none"}
        />
      ))}
    </Svg>
  );
}
