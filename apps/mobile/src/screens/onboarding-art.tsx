// #686: illustration art, exempt from token contract
// Small marks for the first-run onboarding flow (screens/Onboarding). Split out
// so the flow file stays under the repo file-size limit; these are pure,
// stateless SVG glyphs with no onboarding logic in them. The flow's hero lives
// in onboarding-home-art.tsx, which needs animation and its own file.

import React from "react";
import Svg, { Circle, Path, Rect } from "react-native-svg";

import { BRAND } from "../lib/profile";

export function BrandMark({ size = 22 }: { size?: number }): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x={0} y={0} width={24} height={24} rx={7} fill={BRAND} />
      <Circle cx={12} cy={12} r={7} stroke="#fff" strokeWidth={2} />
      <Circle cx={12} cy={12} r={2.2} fill="#fff" />
    </Svg>
  );
}

/** Checkmark badge for the terminal "you're all set" state. */
export function DoneCheck(): React.JSX.Element {
  return (
    <Svg width={36} height={36} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 12l5 5 11-11"
        stroke="#fff"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/**
 * Viewfinder mark for the pairing step's primary action: QR finder modules
 * inside four camera brackets. It has to read as "point your camera at
 * something" rather than "submit a form", because scanning is the way in and
 * pasting a ticket is only the fallback — a plain label on a plain pill leaves
 * that ambiguous.
 */
export function ScanTargetMark({
  size = 58,
}: {
  size?: number;
}): React.JSX.Element {
  const brackets = [
    "M2 15V6a4 4 0 0 1 4-4h9",
    "M41 2h9a4 4 0 0 1 4 4v9",
    "M54 41v9a4 4 0 0 1-4 4h-9",
    "M15 54H6a4 4 0 0 1-4-4v-9",
  ];
  // Three finder squares plus a scatter of data modules: enough of a QR to be
  // recognised at 58pt, far short of enough to be mistaken for a real code.
  const finders = [
    [16, 16],
    [31, 16],
    [16, 31],
  ];
  const modules = [
    [31, 31],
    [36, 31],
    [31, 36],
    [36, 36],
    [40.5, 34],
    [34, 40.5],
  ];
  return (
    <Svg width={size} height={size} viewBox="0 0 56 56" fill="none">
      {brackets.map((d) => (
        <Path
          key={d}
          d={d}
          stroke="#fff"
          strokeOpacity={0.55}
          strokeWidth={2.6}
          strokeLinecap="round"
        />
      ))}
      {finders.map(([x, y]) => (
        <React.Fragment key={`${x}-${y}`}>
          <Rect
            x={x}
            y={y}
            width={9}
            height={9}
            rx={1.8}
            stroke="#fff"
            strokeWidth={2.2}
          />
          <Rect
            x={(x as number) + 3.4}
            y={(y as number) + 3.4}
            width={2.2}
            height={2.2}
            rx={0.6}
            fill="#fff"
          />
        </React.Fragment>
      ))}
      {modules.map(([x, y]) => (
        <Rect
          key={`m-${x}-${y}`}
          x={x}
          y={y}
          width={3.2}
          height={3.2}
          rx={0.9}
          fill="#fff"
        />
      ))}
    </Svg>
  );
}

/** Right-pointing arrow used inside the primary button. */
export function ForwardArrow(): React.JSX.Element {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
      <Path
        d="M5 12h14M13 6l6 6-6 6"
        stroke="#fff"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
