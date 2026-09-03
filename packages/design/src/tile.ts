import { palette, paletteText } from "./palette";

export type TileVariant = "solid" | "gradient" | "glassy" | "flat";

export const TILE_VARIANTS = [
  "solid",
  "gradient",
  "glassy",
  "flat",
] as const satisfies readonly TileVariant[];

export interface TileFinish {
  background: string;
  backgroundColor: string;
  glyphColor: string;
  boxShadow?: string;
  backdropFilter?: string;
}

export function tileFinish(color: string, variant: TileVariant): TileFinish {
  switch (variant) {
    case "gradient":
      return {
        background: `linear-gradient(180deg, ${color} 0%, ${shade(color, -36)} 100%)`,
        backgroundColor: color,
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,.22), inset 0 0 0 0.5px rgba(255,255,255,.18), inset 0 -1px 0 rgba(0,0,0,.2), 0 6px 16px rgba(20,24,32,.10)",
        glyphColor: "#ffffff",
      };
    case "glassy":
      return {
        background: withAlpha(color, 0.22),
        backdropFilter: "blur(14px) saturate(140%)",
        backgroundColor: withAlpha(color, 0.22),
        boxShadow: `inset 0 0 0 0.5px ${withAlpha(color, 0.35)}, inset 0 1px 0 rgba(255,255,255,.30)`,
        glyphColor: color,
      };
    case "flat":
      return {
        background: withAlpha(color, 0.14),
        backgroundColor: withAlpha(color, 0.14),
        boxShadow: `inset 0 0 0 0.5px ${withAlpha(color, 0.28)}`,
        glyphColor: color,
      };
    case "solid":
      return {
        background: color,
        backgroundColor: color,
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,.18), inset 0 -1px 0 rgba(0,0,0,.18), 0 1px 2px rgba(0,0,0,.08), 0 4px 12px rgba(0,0,0,.06)",
        glyphColor: "#ffffff",
      };
  }
}

const HEX_RE = /^#[0-9a-f]{6}$/iu;

function parseHex(hex: string): [number, number, number] | undefined {
  if (!HEX_RE.test(hex)) return undefined;
  const v = hex.slice(1);
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ];
}

function withAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

function shade(hex: string, amount: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const adj = (n: number): number => Math.max(0, Math.min(255, n + amount));
  const out = rgb.map((n) => adj(n).toString(16).padStart(2, "0")).join("");
  return `#${out}`;
}

export const ICON_CHIP_TINT = { dark: 0.2, light: 0.13 } as const;

export interface IconChipFinish {
  backgroundColor: string;
  markColor: string;
}

export const APP_MARK_VIEWBOX = 24;
export const APP_MARK_STROKE = 1.6;
export const APP_MARK_SMALL_STROKE = 1.75;

function solvedMarkColor(hue: string, scheme: "light" | "dark"): string {
  const entry = Object.entries(palette).find(
    ([, base]) => base.toLowerCase() === hue.toLowerCase()
  );
  const key = entry?.[0] as keyof typeof paletteText.light | undefined;
  return key ? paletteText[scheme][key] : hue;
}

export function iconChipFinish(
  hue: string,
  surface: string,
  scheme: "light" | "dark"
): IconChipFinish {
  const fg = parseHex(hue);
  const bg = parseHex(surface);
  const markColor = solvedMarkColor(hue, scheme);
  if (!fg || !bg) return { backgroundColor: surface, markColor };
  const share = ICON_CHIP_TINT[scheme];
  const mixed = fg.map((channel, index) =>
    Math.round(channel * share + (bg[index] ?? channel) * (1 - share))
  );
  return {
    backgroundColor: `#${mixed.map((n) => n.toString(16).padStart(2, "0")).join("")}`,
    markColor,
  };
}
