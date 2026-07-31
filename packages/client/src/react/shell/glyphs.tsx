import type { JSX } from "react";

// Chrome-local line glyphs — the sidebar/titlebar marks that are NOT in
// @centraid/design-tokens (design-token icons render via <Icon name=…>).
// Faithful ports of the inline `Glyph` SVGs in the vanilla chrome.ts: same
// viewBox, stroke treatment, and path data, so a React-drawn glyph is
// pixel-equal to the leftover vanilla one during the migration.

interface GlyphProps {
  size?: number;
  strokeWidth?: number;
}

function Svg({
  size = 15,
  strokeWidth = 1.7,
  children,
}: GlyphProps & { children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export const SidebarOpenGlyph = (p: GlyphProps): JSX.Element => (
  <Svg {...p}>
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9 4v16" />
    </>
  </Svg>
);

export const SidebarClosedGlyph = (p: GlyphProps): JSX.Element => (
  <Svg {...p}>
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M15 4v16" />
    </>
  </Svg>
);

export const ArrowLeftGlyph = (p: GlyphProps): JSX.Element => (
  <Svg {...p}>
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </Svg>
);

export const ArrowRightGlyph = (p: GlyphProps): JSX.Element => (
  <Svg {...p}>
    <path d="M5 12h14M12 5l7 7-7 7" />
  </Svg>
);

export const PencilGlyph = (p: GlyphProps): JSX.Element => (
  <Svg {...p}>
    <>
      <path d="M14 4l6 6L9 21H3v-6z" />
      <path d="M14 4l3-3 6 6-3 3" />
    </>
  </Svg>
);

export const PlusGlyph = (p: GlyphProps): JSX.Element => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

// SearchGlyph / HomeGlyph lived here as local one-offs; the sidebar's nav rows
// now draw every icon from the shared design-tokens set by name (#667), which
// is the one path source, so the local copies were deleted rather than left to
// drift against it.

export const SparkleGlyph = ({
  size = 15,
  strokeWidth = 1.5,
}: GlyphProps): JSX.Element => (
  <Svg size={size} strokeWidth={strokeWidth}>
    <>
      <path d="M12 3l1.8 4.7L18 9l-4.2 1.3L12 15l-1.8-4.7L6 9l4.2-1.3z" />
      <path d="M19 15l.6 1.6L21 17l-1.4.4L19 19l-.6-1.6L17 17l1.4-.4z" />
    </>
  </Svg>
);

export const ChatPanelOpenGlyph = (p: GlyphProps): JSX.Element => (
  <Svg {...p}>
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M13 9l-3 3 3 3" />
    </>
  </Svg>
);

export const ChatPanelClosedGlyph = (p: GlyphProps): JSX.Element => (
  <Svg {...p}>
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M10 9l3 3-3 3" />
    </>
  </Svg>
);
