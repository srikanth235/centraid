import type { JSX } from "react";

// Chrome-local line glyphs — the app-bar marks that are NOT in
// @centraid/design (design-token icons render via <Icon name=…>).
//
// The set shrank with the stem (#707): Plus/Sparkle went with the sidebar rows
// that drew them, and everything the launcher draws comes from the one path
// source in the design package, by name. The two sidebar-toggle glyphs went too
// and have come back — the stem is a 240px band now, and on a narrow window
// reclaiming it is worth more than the promise that it is always there.

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
      aria-hidden="true"
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

/* The filled bar sits on the side the panel is on, so the glyph is a picture of
   the frame rather than an arrow that has to be read as a direction. */
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
