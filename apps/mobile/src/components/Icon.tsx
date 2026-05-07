import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { icons } from '@centraid/design-tokens';
import type { IconName } from '@centraid/design-tokens';

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

export default function Icon({
  name,
  size = 20,
  color = '#141820',
  strokeWidth = 1.5,
}: IconProps): React.JSX.Element | null {
  const paths = icons[name];
  if (!paths) {
    return null;
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {paths.map((p, i) => (
        <Path
          key={i}
          d={p.d}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill={p.fill === 'currentColor' ? color : 'none'}
        />
      ))}
    </Svg>
  );
}
