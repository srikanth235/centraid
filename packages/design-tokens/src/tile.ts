// Centraid — app-tile finishes.
// Four variants per the design system: solid · gradient · glassy · flat.
// `tileFinish(color, variant)` returns a platform-agnostic record that both
// CSS and RN consumers can apply directly. Hue-mixing is done in TS (not
// CSS color-mix or RN-only color libraries) so light/dark, web/native all
// produce the same pixels.

export type TileVariant = 'solid' | 'gradient' | 'glassy' | 'flat';

export const TILE_VARIANTS = [
  'solid',
  'gradient',
  'glassy',
  'flat',
] as const satisfies readonly TileVariant[];

export interface TileFinish {
  /** CSS-shorthand background (may be a gradient). */
  background: string;
  /** Solid fallback for surfaces that can't render gradients (RN View). */
  backgroundColor: string;
  /** Foreground glyph (icon stroke/fill) color. */
  glyphColor: string;
  /** Optional CSS box-shadow string. RN can split into shadow* props. */
  boxShadow?: string;
  /** Optional CSS backdrop-filter. RN: not supported, fall back to opaque fill. */
  backdropFilter?: string;
}

export function tileFinish(color: string, variant: TileVariant): TileFinish {
  switch (variant) {
    case 'gradient':
      // Top→bottom hue darkening — premium feel without an extra gradient
      // texture. -36 on each channel matches the design system's reference.
      return {
        background: `linear-gradient(180deg, ${color} 0%, ${shade(color, -36)} 100%)`,
        backgroundColor: color,
        boxShadow:
          'inset 0 1px 0 rgba(255,255,255,.22), inset 0 0 0 0.5px rgba(255,255,255,.18), inset 0 -1px 0 rgba(0,0,0,.2), 0 6px 16px rgba(20,24,32,.10)',
        glyphColor: '#ffffff',
      };
    case 'glassy':
      return {
        background: withAlpha(color, 0.22),
        backdropFilter: 'blur(14px) saturate(140%)',
        backgroundColor: withAlpha(color, 0.22),
        boxShadow: `inset 0 0 0 0.5px ${withAlpha(color, 0.35)}, inset 0 1px 0 rgba(255,255,255,.30)`,
        glyphColor: color,
      };
    case 'flat':
      return {
        background: withAlpha(color, 0.14),
        backgroundColor: withAlpha(color, 0.14),
        boxShadow: `inset 0 0 0 0.5px ${withAlpha(color, 0.28)}`,
        glyphColor: color,
      };
    default:
      return {
        background: color,
        backgroundColor: color,
        boxShadow:
          'inset 0 1px 0 rgba(255,255,255,.18), inset 0 -1px 0 rgba(0,0,0,.18), 0 1px 2px rgba(0,0,0,.08), 0 4px 12px rgba(0,0,0,.06)',
        glyphColor: '#ffffff',
      };
  }
}

const HEX_RE = /^#([0-9a-f]{6})$/i;

function parseHex(hex: string): [number, number, number] | undefined {
  const m = HEX_RE.exec(hex);
  if (!m) return undefined;
  const v = m[1] as string;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
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
  const out = rgb.map((n) => adj(n).toString(16).padStart(2, '0')).join('');
  return `#${out}`;
}
