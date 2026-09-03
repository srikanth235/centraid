import type { JSX } from "react";

export interface LogoProps {
  size?: number;
}

export default function Logo({ size = 32 }: LogoProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="120"
        cy="120"
        r="80"
        fill="none"
        stroke="currentColor"
        strokeWidth="9"
      />
      <circle cx="120" cy="40" r="14" fill="currentColor" />
      <circle cx="189.28" cy="160" r="14" fill="currentColor" />
      <circle cx="50.72" cy="160" r="14" fill="currentColor" />
      <circle cx="120" cy="120" r="21" fill="currentColor" />
    </svg>
  );
}
