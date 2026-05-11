import React from 'react';
import Svg, { Path, Circle } from 'react-native-svg';

interface LogoProps {
  size?: number;
}

export default function Logo({ size = 32 }: LogoProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 240 240">
      <Path
        d="M 52.82 52.82 A 95 95 0 0 1 187.18 52.82 L 161.01 78.99 A 58 58 0 0 0 78.99 78.99 Z"
        fill="#8B5CF6"
      />
      <Path
        d="M 52.82 187.18 A 95 95 0 0 1 52.82 52.82 L 78.99 78.99 A 58 58 0 0 0 78.99 161.01 Z"
        fill="#F59E0B"
      />
      <Path
        d="M 187.18 187.18 A 95 95 0 0 1 52.82 187.18 L 78.99 161.01 A 58 58 0 0 0 161.01 161.01 Z"
        fill="#06B6D4"
      />
      <Circle cx="120" cy="120" r="12" fill="#E11D48" />
    </Svg>
  );
}
