import { contrastRatio } from "./color";
import { palette, paletteFor } from "./palette";
import type { ColorKey } from "./palette";
import { BRAND } from "./themes";

export type IdentityPaletteKey = keyof typeof palette | "brand";

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

export function identityInitials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return "·";
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  const last = parts.at(-1)!;
  return `${parts[0]!.slice(0, 1)}${last.slice(0, 1)}`.toUpperCase();
}

function identityHash(value: string): number {
  let hash = 0;
  for (const character of value) {
    const next = Math.trunc(Math.imul(hash, 31) + character.codePointAt(0)!);
    hash = next > 0x7fffffff ? next - 0x1_0000_0000 : next;
  }
  return Math.abs(hash);
}

export function identityColor(
  value: string,
  preferred?: IdentityPaletteKey
): string {
  if (preferred) return preferred === "brand" ? BRAND : palette[preferred];
  if (!value.trim()) return BRAND;
  return IDENTITY_COLORS[identityHash(value) % IDENTITY_COLORS.length] ?? BRAND;
}

export const IDENTITY_HUE_KEYS: readonly ColorKey[] = [
  "rose",
  "amber",
  "ochre",
  "forest",
  "teal",
  "slate",
  "indigo",
  "violet",
];

export function identityHueKey(id: string): ColorKey {
  const keys = IDENTITY_HUE_KEYS;
  return keys[identityHash(id.trim()) % keys.length] ?? "slate";
}

const HUE_VAR_OPEN = "var(--c-";

export function partyHueValue(key: ColorKey): string {
  return `${HUE_VAR_OPEN}${key})`;
}

export function partyHueKey(
  partyId: string,
  avatarColor?: string | null
): ColorKey | null {
  const stored = (avatarColor ?? "").trim();
  if (!stored) return identityHueKey(partyId);
  if (!stored.startsWith(HUE_VAR_OPEN) || !stored.endsWith(")")) return null;
  const key = stored.slice(HUE_VAR_OPEN.length, -1);
  return (IDENTITY_HUE_KEYS as readonly string[]).includes(key)
    ? (key as ColorKey)
    : null;
}

export function identityFill(id: string, scheme: "light" | "dark"): string {
  return paletteFor(scheme)[identityHueKey(id)];
}

export function identityInk(
  fill: string,
  ink: string,
  inkInverse: string
): string {
  try {
    return contrastRatio(inkInverse, fill) >= contrastRatio(ink, fill)
      ? inkInverse
      : ink;
  } catch {
    return ink;
  }
}
