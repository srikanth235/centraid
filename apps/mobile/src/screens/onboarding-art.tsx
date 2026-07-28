// Decorative artwork for the first-run onboarding flow (screens/Onboarding).
// Split out so the flow file stays under the repo file-size limit; these are
// pure, stateless SVG marks with no onboarding logic in them.

import React from 'react';
import Svg, { Circle, Defs, Ellipse, G, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

import { BRAND_TEAL } from '../lib/profile';

export function BrandMark({ size = 22 }: { size?: number }): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x={0} y={0} width={24} height={24} rx={7} fill={BRAND_TEAL} />
      <Circle cx={12} cy={12} r={7} stroke="#fff" strokeWidth={2} />
      <Circle cx={12} cy={12} r={2.2} fill="#fff" />
    </Svg>
  );
}

/** Simplified "Centraid orbit" hero — a glowing core with orbiting app tiles. */
export function OrbitArt(): React.JSX.Element {
  return (
    <Svg width={280} height={200} viewBox="0 0 200 150" fill="none">
      <Defs>
        <RadialGradient id="core" cx="38%" cy="28%" r="80%">
          <Stop offset="0%" stopColor="#63E2C6" />
          <Stop offset="55%" stopColor="#22A78F" />
          <Stop offset="100%" stopColor="#0E7B6C" />
        </RadialGradient>
        <RadialGradient id="glow" cx="50%" cy="50%" r="50%">
          <Stop offset="0%" stopColor="#33B8A1" stopOpacity={0.45} />
          <Stop offset="100%" stopColor="#33B8A1" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Ellipse cx={100} cy={76} rx={74} ry={62} fill="url(#glow)" />
      <G transform="rotate(-16 100 76)">
        <Ellipse
          cx={100}
          cy={76}
          rx={46}
          ry={30}
          fill="none"
          stroke="rgba(51,184,161,.45)"
          strokeWidth={1.3}
        />
        <Ellipse
          cx={100}
          cy={76}
          rx={72}
          ry={47}
          fill="none"
          stroke="rgba(51,184,161,.26)"
          strokeWidth={1.3}
        />
      </G>
      <G transform="rotate(-10 46 52)">
        <Rect x={39.5} y={45.5} width={13} height={13} rx={4} fill="#4E68DD" />
      </G>
      <G transform="rotate(9 150 46)">
        <Rect x={143.5} y={39.5} width={13} height={13} rx={4} fill="#E55772" />
      </G>
      <G transform="rotate(-8 160 96)">
        <Rect x={153.5} y={89.5} width={13} height={13} rx={4} fill="#E89A3C" />
      </G>
      <G transform="rotate(10 52 104)">
        <Rect x={45.5} y={97.5} width={13} height={13} rx={4} fill="#5C8A4E" />
      </G>
      <Circle cx={100} cy={76} r={21} fill="url(#core)" />
      <Circle cx={100} cy={76} r={7.6} stroke="#fff" strokeWidth={1.8} fill="none" />
      <Circle cx={100} cy={76} r={2.4} fill="#fff" />
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
