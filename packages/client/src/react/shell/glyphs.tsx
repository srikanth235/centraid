import type { JSX } from "react";

// Chrome-local line glyphs — the app-bar marks that are NOT in
// @centraid/design (design-token icons render via <Icon name=…>).
// Faithful ports of the inline `Glyph` SVGs in the vanilla chrome.ts: same
// viewBox, stroke treatment, and path data.
//
// The set shrank with the stem (#707): the two sidebar-toggle glyphs went with
// the collapse affordance the stem does not have, and Plus/Sparkle went with
// the sidebar rows that drew them. Everything the launcher draws comes from the
// one path source in the design package, by name.

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
