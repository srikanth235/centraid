import type { JSX } from "react";

export interface LogoProps {
  size?: number;
}

/**
 * The product mark — the orbit glyph, drawn in INK.
 *
 * It was a teal rounded square with a white orbit until #707. The Binding
 * Layer's third invariant is that the shell spends no colour at all, so that
 * every hue on screen provably belongs to an app; a brand-teal mark sitting at
 * the top of the stem would be the one exception, and the exception is what
 * would make the rule unreadable. The mark now inherits `currentColor` — the
 * stem paints it `--accent`, which IS `--text` — so it flips with the ramp and
 * costs the palette nothing.
 *
 * Self-contained (no stylesheet, no token import) so the shell can render it
 * before any CSS is available.
 */
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
