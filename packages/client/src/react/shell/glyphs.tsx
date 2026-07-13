import type { JSX } from 'react';

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

export const SearchGlyph = (p: GlyphProps): JSX.Element => (
  <Svg {...p}>
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </>
  </Svg>
);

export const HomeGlyph = (p: GlyphProps): JSX.Element => (
  <Svg {...p}>
    <>
      <path d="M3 11l9-7 9 7" />
      <path d="M5 10v10h14V10" />
    </>
  </Svg>
);

export const StarGlyph = (p: GlyphProps): JSX.Element => (
  <Svg {...p}>
    <path d="M12 3l2.6 5.3L20 9.3l-4 3.9.9 5.5L12 16.1 7.1 18.7 8 13.2 4 9.3l5.4-1z" />
  </Svg>
);

export const SparkleGlyph = ({ size = 15, strokeWidth = 1.5 }: GlyphProps): JSX.Element => (
  <Svg size={size} strokeWidth={strokeWidth}>
    <>
      <path d="M12 3l1.8 4.7L18 9l-4.2 1.3L12 15l-1.8-4.7L6 9l4.2-1.3z" />
      <path d="M19 15l.6 1.6L21 17l-1.4.4L19 19l-.6-1.6L17 17l1.4-.4z" />
    </>
  </Svg>
);

export const SettingsGlyph = (p: GlyphProps): JSX.Element => (
  <Svg {...p}>
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
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
