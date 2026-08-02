import { palette } from "./palette";
import { BRAND } from "./themes";

export type IdentityPaletteKey = keyof typeof palette | "brand";

/** Canonical identity fills for people, vaults, and app marks. The first
 * colour is the product default; every renderer consumes this same ordered
 * palette instead of inventing a local list or hash. */
export const IDENTITY_COLORS = [
  BRAND,
  palette.indigo,
  palette.rose,
  palette.violet,
  palette.amber,
  palette.forest,
  palette.ochre,
  palette.slate,
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
