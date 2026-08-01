import type { JSX } from "react";

export interface LogoProps {
  size?: number;
}

/**
 * Brand mark — the teal orbit glyph from assets/logo.svg. Self-contained so
 * the shell can render it before any stylesheet is available.
 */
export default function Logo({ size = 32 }: LogoProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 240 240" aria-hidden="true">
      <rect width="240" height="240" rx="52" fill="#3EC8B4" />
      <circle
        cx="120"
        cy="120"
        r="80"
        fill="none"
        stroke="#fff"
        strokeWidth="9"
      />
      <circle cx="120" cy="40" r="14" fill="#fff" />
      <circle cx="189.28" cy="160" r="14" fill="#fff" />
      <circle cx="50.72" cy="160" r="14" fill="#fff" />
      <circle cx="120" cy="120" r="21" fill="#fff" />
    </svg>
  );
}
