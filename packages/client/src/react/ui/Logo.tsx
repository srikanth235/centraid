import type { JSX } from 'react';

export interface LogoProps {
  size?: number;
}

/**
 * Brand mark — the three-arc + core-dot glyph. A DOM twin of the mobile
 * `<Logo>` (react-native-svg), drawn with the identical viewBox, paths and
 * fills so both platforms show the same identity mark. Self-contained: no
 * CSS class dependency.
 */
export default function Logo({ size = 32 }: LogoProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 240 240" aria-hidden="true">
      <path
        d="M 52.82 52.82 A 95 95 0 0 1 187.18 52.82 L 161.01 78.99 A 58 58 0 0 0 78.99 78.99 Z"
        fill="#8B5CF6"
      />
      <path
        d="M 52.82 187.18 A 95 95 0 0 1 52.82 52.82 L 78.99 78.99 A 58 58 0 0 0 78.99 161.01 Z"
        fill="#F59E0B"
      />
      <path
        d="M 187.18 187.18 A 95 95 0 0 1 52.82 187.18 L 78.99 161.01 A 58 58 0 0 0 161.01 161.01 Z"
        fill="#06B6D4"
      />
      <circle cx="120" cy="120" r="12" fill="#E11D48" />
    </svg>
  );
}
