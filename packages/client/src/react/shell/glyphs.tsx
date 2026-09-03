import type { JSX } from "react";

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
