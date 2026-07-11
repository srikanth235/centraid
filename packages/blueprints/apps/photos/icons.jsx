// Shared line-icon set (the reference mockup's own SVG paths, reused
// verbatim — generic Feather-style glyphs, not app-specific artwork) so the
// v2 chrome never falls back to emoji ("no emoji in chrome" — the build
// prompt's visual system section). Every icon is a plain function component:
// `stroke="currentColor"` so callers color them via CSS, no props needed
// beyond an optional `size`.
const base = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round' };

function Svg({ size = 18, children, viewBox = '0 0 24 24', ...rest }) {
  return (
    <svg width={size} height={size} viewBox={viewBox} aria-hidden="true" {...base} {...rest}>
      {children}
    </svg>
  );
}

export const CameraIcon = (p) => (
  <Svg {...p}>
    <path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" />
    <circle cx="12" cy="13" r="3.4" />
  </Svg>
);

export const GridIcon = (p) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="8.5" cy="10" r="1.6" />
    <path d="m21 16-5-5L5 19" />
  </Svg>
);

export const HeartIcon = ({ filled, ...p }) => (
  <Svg {...p} fill={filled ? 'currentColor' : 'none'}>
    <path d="M12 20s-7-4.4-9.2-8.4C1.3 8.9 2.6 6 5.4 6c1.8 0 3 1 3.6 2 .6-1 1.8-2 3.6-2 2.8 0 4.1 2.9 2.6 5.6C19 15.6 12 20 12 20z" />
  </Svg>
);

export const AlbumsIcon = (p) => (
  <Svg {...p}>
    <rect x="3" y="7" width="18" height="13" rx="2" />
    <path d="M6 7V5a1 1 0 0 1 1-1h4l1.5 2" />
  </Svg>
);

export const DuplicatesIcon = (p) => (
  <Svg {...p}>
    <rect x="4" y="4" width="12" height="12" rx="2" />
    <path d="M9 20h9a2 2 0 0 0 2-2V9" />
  </Svg>
);

export const TrashIcon = (p) => (
  <Svg {...p} strokeWidth={1.6}>
    <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
  </Svg>
);

export const CloseIcon = (p) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const MenuIcon = (p) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);

export const SearchIcon = (p) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </Svg>
);

export const ZoomOutIcon = (p) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </Svg>
);

export const ZoomInIcon = (p) => (
  <Svg {...p}>
    <rect x="3" y="3" width="8" height="8" rx="1" />
    <rect x="13" y="13" width="8" height="8" rx="1" />
  </Svg>
);

export const SparkleIcon = (p) => (
  <Svg {...p}>
    <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
    <path d="m9.5 12 2 2 3.5-3.5" />
  </Svg>
);

export const InfoIcon = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </Svg>
);

export const DownloadIcon = (p) => (
  <Svg {...p}>
    <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />
  </Svg>
);

export const ShareIcon = (p) => (
  <Svg {...p}>
    <circle cx="18" cy="5" r="2.6" />
    <circle cx="6" cy="12" r="2.6" />
    <circle cx="18" cy="19" r="2.6" />
    <path d="M8.3 10.7 15.7 6.3M8.3 13.3l7.4 4.4" />
  </Svg>
);

export const EditIcon = (p) => (
  <Svg {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </Svg>
);

export const PlayIcon = (p) => (
  <Svg {...p} fill="currentColor" stroke="none">
    <path d="M8 5v14l11-7z" />
  </Svg>
);

export const PauseIcon = (p) => (
  <Svg {...p} fill="currentColor" stroke="none">
    <rect x="6" y="5" width="4" height="14" rx="1" />
    <rect x="14" y="5" width="4" height="14" rx="1" />
  </Svg>
);

export const ChevronLeftIcon = (p) => (
  <Svg {...p} strokeWidth={1.9}>
    <path d="m15 6-6 6 6 6" />
  </Svg>
);

export const ChevronRightIcon = (p) => (
  <Svg {...p} strokeWidth={1.9}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);

export const CheckIcon = (p) => (
  <Svg {...p} stroke="#fff" strokeWidth={3}>
    <path d="m5 12 5 5L20 6" />
  </Svg>
);

export const PlusIcon = (p) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const ShieldIcon = (p) => (
  <Svg {...p}>
    <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
    <path d="m9.5 12 2 2 3.5-3.5" />
  </Svg>
);

export const PinIcon = (p) => (
  <Svg {...p}>
    <path d="M12 21s-6-5.6-6-10a6 6 0 1 1 12 0c0 4.4-6 10-6 10z" />
    <circle cx="12" cy="11" r="2" />
  </Svg>
);

export const RenameIcon = (p) => (
  <Svg {...p} size={14}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </Svg>
);
