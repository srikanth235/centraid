// Lucide-style icons as raw SVG path data, viewBox 24x24.
// Each entry is an ordered list of `<path>` definitions. Consumers either
// wrap them in an SVG string (desktop renderer) or a react-native-svg
// <Path> (mobile). Same source of truth for both.

export interface IconPath {
  d: string;
  fill?: 'currentColor';
}

// Defined as `as const` so the keys narrow to a literal union for IconName,
// then re-typed via `Record<IconName, readonly IconPath[]>` so that consumers
// see the optional `fill` field on each path entry.
const ICON_DATA = {
  Check: [{ d: 'M5 12l5 5L20 7' }],
  Plus: [{ d: 'M12 5v14M5 12h14' }],
  X: [{ d: 'M6 6l12 12M18 6L6 18' }],
  ArrowLeft: [{ d: 'M19 12H5M12 19l-7-7 7-7' }],
  ArrowRight: [{ d: 'M5 12h14M12 5l7 7-7 7' }],
  Search: [{ d: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z' }, { d: 'M20 20l-3.5-3.5' }],
  Trash: [
    {
      d: 'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M5 6l1 14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-14M10 11v6M14 11v6',
    },
  ],
  Pencil: [{ d: 'M14 4l6 6L9 21H3v-6z' }, { d: 'M14 4l3-3 6 6-3 3' }],
  Play: [{ d: 'M7 5l12 7-12 7z', fill: 'currentColor' }],
  Pause: [{ d: 'M6 5h4v14H6zM14 5h4v14h-4z', fill: 'currentColor' }],
  Skip: [{ d: 'M6 4l10 8-10 8zM18 5v14' }],
  Reset: [{ d: 'M3 12a9 9 0 1 0 3-6.7L3 8' }, { d: 'M3 3v5h5' }],
  // Paper-plane send glyph. The previous artwork was a plain right-arrow
  // visually identical to the forward-nav icon — see Refined Screens §B2.
  Send: [{ d: 'M22 2L11 13' }, { d: 'M22 2l-7 20-4-9-9-4z' }],
  Refresh: [{ d: 'M21 12a9 9 0 1 1-3-6.7M21 3v5h-5' }],
  Copy: [
    { d: 'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z' },
    { d: 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1' },
  ],
  Star: [{ d: 'M12 3l2.7 5.5 6 .9-4.35 4.25 1.05 6L12 17.8 6.6 20.65l1.05-6L3.3 9.4l6-.9z' }],
  Compass: [
    { d: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z' },
    { d: 'M16 8l-2.4 5.6L8 16l2.4-5.6z', fill: 'currentColor' },
  ],
  Bolt: [{ d: 'M13 2L4 13h7l-2 9 11-13h-8z' }],
  Activity: [{ d: 'M3 12h4l3 8 4-16 3 8h4' }],
  ChevronDown: [{ d: 'M6 9l6 6 6-6' }],
  Coin: [
    { d: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z' },
    {
      d: 'M14.5 8.5c0-1.4-1.1-2-2.5-2s-2.5.7-2.5 2 1.1 1.9 2.5 1.9 2.5.6 2.5 2-1.1 2.1-2.5 2.1-2.5-.7-2.5-2.1M12 5v1.5M12 17v1.5',
    },
  ],
  Globe: [
    { d: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z' },
    {
      d: 'M3 12h18M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3z',
    },
  ],
  Phone: [
    { d: 'M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z' },
    { d: 'M11 18.5h2' },
  ],
  Tablet: [
    { d: 'M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z' },
    { d: 'M11 18h2' },
  ],
  Monitor: [{ d: 'M3 4h18v12H3z' }, { d: 'M9 20h6M12 16v4' }],
  Command: [
    {
      d: 'M9 7.5A2.5 2.5 0 1 0 6.5 10H10v4H6.5A2.5 2.5 0 1 0 9 16.5V13h6v3.5A2.5 2.5 0 1 0 17.5 14H14v-4h3.5A2.5 2.5 0 1 0 15 7.5V11H9z',
    },
  ],
  Share: [{ d: 'M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7' }, { d: 'M16 6l-4-4-4 4M12 2v14' }],
  Eye: [
    { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z' },
    { d: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z' },
  ],
  Code: [{ d: 'M8 6l-6 6 6 6M16 6l6 6-6 6' }],
  History: [{ d: 'M3 12a9 9 0 1 0 3-6.7L3 8' }, { d: 'M3 3v5h5M12 7v5l3 2' }],
  Sparkle: [
    { d: 'M12 3l1.8 4.7L18 9l-4.2 1.3L12 15l-1.8-4.7L6 9l4.2-1.3z' },
    { d: 'M19 15l.6 1.6L21 17l-1.4.4L19 19l-.6-1.6L17 17l1.4-.4z' },
  ],
  MoreHoriz: [{ d: 'M6 12h.01M12 12h.01M18 12h.01' }],
  MoreVert: [{ d: 'M12 6h.01M12 12h.01M12 18h.01' }],
  Folder: [{ d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }],
  Save: [
    { d: 'M5 4h11l4 4v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z' },
    { d: 'M8 4v5h7V4M8 14h8v7H8z' },
  ],
  Settings: [
    {
      d: 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    },
    { d: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z' },
  ],

  // App-tile icons
  Todo: [
    { d: 'M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z' },
    { d: 'M8 10h8M8 14h5' },
    { d: 'M7 10l1 1 2-2' },
  ],
  Habit: [{ d: 'M12 21s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 11c0 5.5-7 10-7 10z' }],
  Journal: [{ d: 'M5 4a2 2 0 0 1 2-2h11v20H7a2 2 0 0 1-2-2z' }, { d: 'M9 8h6M9 12h6M9 16h4' }],
  Pomodoro: [{ d: 'M20 13a8 8 0 1 1-16 0 8 8 0 0 1 16 0z' }, { d: 'M12 13l3-2M9 4h6M12 4V2' }],
  Plant: [
    { d: 'M12 22V11' },
    { d: 'M12 11c-3 0-6-2-6-6 4 0 6 3 6 6z' },
    { d: 'M12 14c3 0 6-2 6-6-4 0-6 3-6 6z' },
    { d: 'M8 22h8' },
  ],
  Water: [{ d: 'M12 3l-5 7a6 6 0 0 0 10 0z' }, { d: 'M9.5 13a2.5 2.5 0 0 0 2.5 2.5' }],
  Gift: [
    { d: 'M3 9h18v12H3zM3 13h18M12 9v12' },
    {
      d: 'M12 9c-2 0-4-1-4-3a2 2 0 0 1 4 0c0 2 0 3 0 3zM12 9c2 0 4-1 4-3a2 2 0 0 0-4 0c0 2 0 3 0 3z',
    },
  ],
  Mood: [
    { d: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z' },
    { d: 'M9 10v0M15 10v0' },
    { d: 'M8.5 14.5a4 4 0 0 0 7 0' },
  ],
  Cellular: [{ d: 'M2 18v3h2v-3zM7 14v7h2v-7zM12 10v11h2V10zM17 6v15h2V6z', fill: 'currentColor' }],
  Wifi: [
    { d: 'M5 12.5a10 10 0 0 1 14 0M2 8.5a15 15 0 0 1 20 0M8.5 16.5a5 5 0 0 1 7 0' },
    { d: 'M12 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', fill: 'currentColor' },
  ],
  Battery: [{ d: 'M2 7h18v10H2z' }, { d: 'M4 9h10v6H4z', fill: 'currentColor' }, { d: 'M22 11v2' }],
  // Profile / space switcher glyphs (issue: profiles feature).
  User: [{ d: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z' }, { d: 'M4.5 20.5a7.5 7.5 0 0 1 15 0' }],
  Users: [
    { d: 'M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z' },
    { d: 'M2.5 20.5a6.5 6.5 0 0 1 13 0' },
    { d: 'M16.5 4.8a3.5 3.5 0 0 1 0 6.9M22 20.5a6.5 6.5 0 0 0-4.2-6.1' },
  ],
  SwitchVert: [{ d: 'M8 4v16M8 20l-3-3M8 4l3 3M16 20V4M16 4l3 3M16 20l-3-3' }],
  Home: [{ d: 'M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-7h-6v7H5a2 2 0 0 1-2-2z' }],
  Book: [{ d: 'M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z' }, { d: 'M4 17a2 2 0 0 1 2-2h13' }],
  Music: [
    { d: 'M9 18V5l11-2v13' },
    { d: 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z' },
    { d: 'M17 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z' },
  ],
  Gym: [{ d: 'M6 9v6M3 11v2M18 9v6M21 11v2M6 12h12' }],
  Calendar: [
    { d: 'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z' },
    { d: 'M3 10h18M8 3v4M16 3v4' },
  ],
  Camera: [
    { d: 'M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' },
    { d: 'M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z' },
  ],
} as const;

export type IconName = keyof typeof ICON_DATA;
export const icons: Record<IconName, readonly IconPath[]> = ICON_DATA;
