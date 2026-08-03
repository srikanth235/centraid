import { palette } from "./palette";
import { BRAND } from "./themes";

export type IdentityPaletteKey = keyof typeof palette | "brand";

/** Canonical identity fills for people, vaults, and app marks — the identity
 * hue wheel, in wheel order. The first colour is the product default, which in
 * the Binding Layer is INK: an identity nobody has chosen a hue for renders in
 * the same ink as everything else, rather than borrowing an app's colour.
 * Every renderer consumes this same ordered list instead of inventing a local
 * palette or hash. */
export const IDENTITY_COLORS = [
  BRAND,
  palette.rose,
  palette.amber,
  palette.ochre,
  palette.forest,
  palette.teal,
  palette.slate,
  palette.indigo,
  palette.violet,
] as const;

/** Stable two-letter identity initials shared by every runtime. */
export function identityInitials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return "·";
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  const last = parts.at(-1)!;
  return `${parts[0]!.slice(0, 1)}${last.slice(0, 1)}`.toUpperCase();
}

/** Deterministic app/person hue selection; never randomises identity. */
export function identityColor(
  value: string,
  preferred?: IdentityPaletteKey
): string {
  if (preferred) return preferred === "brand" ? BRAND : palette[preferred];
  if (!value.trim()) return BRAND;
  let hash = 0;
  for (const character of value) {
    const next = Math.trunc(Math.imul(hash, 31) + character.codePointAt(0)!);
    hash = next > 0x7fffffff ? next - 0x1_0000_0000 : next;
  }
  return IDENTITY_COLORS[Math.abs(hash) % IDENTITY_COLORS.length] ?? BRAND;
}
