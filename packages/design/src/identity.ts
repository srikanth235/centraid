import { contrastRatio } from "./color";
import { palette, paletteFor } from "./palette";
import type { ColorKey } from "./palette";
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

/** The one string hash every identity deriver here shares, so two renderers
 *  cannot disagree about which bucket an identity falls into. 32-bit, wrapped
 *  by hand rather than with `|0` so the arithmetic is the same on every
 *  runtime. */
function identityHash(value: string): number {
  let hash = 0;
  for (const character of value) {
    const next = Math.trunc(Math.imul(hash, 31) + character.codePointAt(0)!);
    hash = next > 0x7fffffff ? next - 0x1_0000_0000 : next;
  }
  return Math.abs(hash);
}

/** Deterministic app/person hue selection; never randomises identity. */
export function identityColor(
  value: string,
  preferred?: IdentityPaletteKey
): string {
  if (preferred) return preferred === "brand" ? BRAND : palette[preferred];
  if (!value.trim()) return BRAND;
  return IDENTITY_COLORS[identityHash(value) % IDENTITY_COLORS.length] ?? BRAND;
}

/**
 * The identity wheel as HUE KEYS, in wheel order — `IDENTITY_COLORS` without
 * the ink default and without a theme baked in.
 *
 * The ink default is right for a mark nobody has claimed a hue for (a vault, an
 * account), and wrong for a FILLED person circle: a black disc in a row of
 * coloured ones reads as an error rather than as a default, and `BRAND` is a
 * fixed `#141414` in both themes, so dark theme would put near-black ink
 * (`textInv`) on a near-black disc at 1.05:1. A face always takes a hue.
 */
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

/**
 * Which point on the hue wheel an identity takes — keyed by a STABLE id (a
 * `party_id`, a vault id), never by a display name, which changes the moment
 * somebody is renamed and collides whenever two people share one.
 *
 * Returns the KEY, not a colour, because the colour is per theme: every client
 * resolves the key through its own scheme (`--c-<key>` in CSS, `colors.c<Key>`
 * on the phone, `identityFill` where a hex is needed), so the same person is
 * the same hue on every surface without any client shipping a second wheel.
 */
export function identityHueKey(id: string): ColorKey {
  const keys = IDENTITY_HUE_KEYS;
  return keys[identityHash(id.trim()) % keys.length] ?? "slate";
}

/**
 * An identity's fill as a hex, on the ring the given theme paints.
 *
 * This is the `--c-<key>` ring itself (`oklch(0.50 …)` light, `oklch(0.72 …)`
 * dark), not the solved `--c-<key>-text` rung: `paletteText` solves hue-on-type
 * against a 12% wash of the hue, which is a different question from ink on a
 * SOLID disc. The ring already carries `textInv` at AA in both themes —
 * measured 5.62:1 at worst in light and 7.47:1 at worst in dark — so a filled
 * face circle pairs this with `textInv` and nothing else.
 */
export function identityFill(id: string, scheme: "light" | "dark"): string {
  return paletteFor(scheme)[identityHueKey(id)];
}

/**
 * Which of the theme's two inks a FILLED identity disc should carry — measured
 * against the disc, not assumed.
 *
 * A derived fill always wants `textInv` (the ring is solved for it in both
 * themes). A STORED `avatar_color` is a different animal: it is whatever the
 * People app wrote for that person, which today is a light-ring hex from
 * `IDENTITY_COLORS` and stays that hex when the phone flips to dark — where
 * near-black inverse ink lands at ~3.1:1 on it and the ordinary ink lands at
 * ~5.7:1. Honouring the member's colour and staying legible is exactly this
 * comparison, so it is made rather than guessed.
 *
 * `fill` comes out of the vault and can be any string a writer put there, so an
 * unparseable one falls back to the ordinary ink instead of throwing on a
 * render path — the disc is then a colour we could not read, with the ink that
 * every other surface uses.
 */
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
