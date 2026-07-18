// Small shared presentational bits used across Sidebar/List/Detail/overlays.
// Pure functions of props — no app state.
import type { FC } from '../react-core.min.js';
import { CAT_ICON_PATHS, ICON_PATHS } from '../icons.ts';

// A trusted static SVG path fragment wrapped in a real <svg> sized/stroked
// for the call site — the React analogue of app.js's `iconSvg()`. Setting
// `dangerouslySetInnerHTML` on the <svg> itself (rather than a wrapper
// element) keeps the emitted DOM identical to the Lit original: no extra
// wrapper node, just `<svg>…real path/rect/circle children…</svg>`.
export function Icon({
  name,
  size = 16,
  sw = 1.7,
  stroke = 'currentColor',
  fill = 'none',
}: {
  name: string;
  size?: number;
  sw?: number;
  stroke?: string;
  fill?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={stroke}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] ?? '' }}
    />
  );
}

export function CatIcon({
  type,
  size = 16,
  sw = 1.7,
}: {
  type: string;
  size?: number;
  sw?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: CAT_ICON_PATHS[type] ?? '' }}
    />
  );
}

// The kit meter is a native custom element (`<kit-meter ratio tone>`, defined
// in kit/elements.js). TSX has no intrinsic-element type for it, so we render
// it through a value typed as a component — at runtime this IS the string
// 'kit-meter', so `jsx('kit-meter', {ratio, tone})` emits the exact same host
// element the JSX original did (React sets ratio/tone as attributes on a custom
// element). The cast is the one place that host tag becomes typed.
export const KitMeter = 'kit-meter' as unknown as FC<{ ratio: number; tone: string }>;
