// Small shared presentational bits used across Sidebar/List/Detail/overlays.
// Pure functions of props — no app state.

import { CAT_ICON_PATHS, ICON_PATHS } from "../icons.ts";

// A trusted static SVG path fragment wrapped in a real <svg> sized/stroked
// for the call site — the React analogue of app.js's `iconSvg()`. Setting
// `dangerouslySetInnerHTML` on the <svg> itself (rather than a wrapper
// element) keeps the emitted DOM identical to the Lit original: no extra
// wrapper node, just `<svg>…real path/rect/circle children…</svg>`.
export function Icon({
  name,
  size = 16,
  sw = 1.7,
  stroke = "currentColor",
  fill = "none",
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
      // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
      dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] ?? "" }}
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
      // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
      dangerouslySetInnerHTML={{ __html: CAT_ICON_PATHS[type] ?? "" }}
    />
  );
}
