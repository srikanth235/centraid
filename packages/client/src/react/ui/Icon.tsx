import type { JSX } from "react";

import { icons } from "@centraid/design";
import type { IconName } from "@centraid/design";

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

export default function Icon({
  name,
  size = 20,
  color = "currentColor",
  strokeWidth = 1.5,
}: IconProps): JSX.Element | null {
  const paths = icons[name];
  if (!paths) {
    return null;
  }
  return (
    <svg
      aria-hidden="true"
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
        p.fill === "currentColor" ? (
          <path key={i} d={p.d} fill={color} stroke="none" />
        ) : (
          <path key={i} d={p.d} />
        )
      )}
    </svg>
  );
}
