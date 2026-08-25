// governance: allow-repo-hygiene file-size-limit — one flat glyph registry, on the same ground roles.ts is waived: it is a normative TABLE, and every consumer (desktop renderer, mobile <Path>, the icon resolver) reads the whole map. A split would put half the product's marks in a second file with no rule for which half, and a mark landing in the wrong half is a lookup that silently returns nothing.
// Lucide-style icons as raw SVG path data, viewBox 24x24.
// Each entry is an ordered list of `<path>` definitions. Consumers either
// wrap them in an SVG string (desktop renderer) or a react-native-svg
// <Path> (mobile). Same source of truth for both.

export interface IconPath {
  d: string;
  fill?: "currentColor";
  /** `fill-rule="evenodd"` — the knockout rule the handoff brief's app-icon
   *  silhouette contract specifies ("App icons": identity lives in the
   *  primary silhouette as evenodd knockouts, so the container tint reads as
   *  negative space). No shipped icon sets this yet (see
   *  icons-contract.test.ts's app-icon silhouette suite) — it exists so a
   *  future filled compound mark has somewhere real to declare it, rendered
   *  by `pathMarkup` below the moment it does. */
  fillRule?: "evenodd";
}

// Defined as `as const` so the keys narrow to a literal union for IconName,
// then re-typed via `Record<IconName, readonly IconPath[]>` so that consumers
// see the optional `fill` field on each path entry.
const ICON_DATA = {
  AddressBook: [
    {
      d: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
    },
    { d: "M8 10h.01M8 14h.01M11 10h6M11 14h6" },
  ],
  Check: [{ d: "M5 12l5 5L20 7" }],
  Plus: [{ d: "M12 5v14M5 12h14" }],
  X: [{ d: "M6 6l12 12M18 6L6 18" }],
  ArrowLeft: [{ d: "M19 12H5M12 19l-7-7 7-7" }],
  ArrowRight: [{ d: "M5 12h14M12 5l7 7-7 7" }],
  Search: [
    { d: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z" },
    { d: "M20 20l-3.5-3.5" },
  ],
  Trash: [
    {
      d: "M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M5 6l1 14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-14M10 11v6M14 11v6",
    },
  ],
  Pencil: [{ d: "M14 4l6 6L9 21H3v-6z" }, { d: "M14 4l3-3 6 6-3 3" }],
  Play: [{ d: "M7 5l12 7-12 7z", fill: "currentColor" }],
  Pause: [{ d: "M6 5h4v14H6zM14 5h4v14h-4z", fill: "currentColor" }],
  Skip: [{ d: "M6 4l10 8-10 8zM18 5v14" }],
  Reset: [{ d: "M3 12a9 9 0 1 0 3-6.7L3 8" }, { d: "M3 3v5h5" }],
  // Paper-plane send glyph, deliberately not a plain right-arrow: that would
  // be visually identical to the forward-nav icon — see Refined Screens §B2.
  Send: [{ d: "M22 2L11 13" }, { d: "M22 2l-7 20-4-9-9-4z" }],
  Refresh: [{ d: "M21 12a9 9 0 1 1-3-6.7M21 3v5h-5" }],
  Copy: [
    {
      d: "M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z",
    },
    { d: "M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" },
  ],
  Star: [
    {
      d: "M12 3l2.7 5.5 6 .9-4.35 4.25 1.05 6L12 17.8 6.6 20.65l1.05-6L3.3 9.4l6-.9z",
    },
  ],
  Compass: [
    { d: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" },
    { d: "M16 8l-2.4 5.6L8 16l2.4-5.6z", fill: "currentColor" },
  ],
  Bolt: [{ d: "M13 2L4 13h7l-2 9 11-13h-8z" }],
  BoltOff: [{ d: "m3 3 18 18" }, { d: "m13 2-9 11h7l-2 9 4-4" }],
  Activity: [{ d: "M3 12h4l3 8 4-16 3 8h4" }],
  BarChart2: [{ d: "M4 20V10M10 20V4M16 20v-7M22 20H2" }],
  ChevronDown: [{ d: "M6 9l6 6 6-6" }],
  Coin: [
    { d: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" },
    {
      d: "M14.5 8.5c0-1.4-1.1-2-2.5-2s-2.5.7-2.5 2 1.1 1.9 2.5 1.9 2.5.6 2.5 2-1.1 2.1-2.5 2.1-2.5-.7-2.5-2.1M12 5v1.5M12 17v1.5",
    },
  ],
  Globe: [
    { d: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" },
    {
      d: "M3 12h18M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3z",
    },
  ],
  Cloud: [
    { d: "M7 18h10a4 4 0 0 0 .7-7.94A6 6 0 0 0 6.2 8.4 4.5 4.5 0 0 0 7 18z" },
  ],
  CloudOff: [
    { d: "m3 3 18 18" },
    { d: "M7 18h10a4 4 0 0 0 .7-7.94A6 6 0 0 0 6.2 8.4 4.5 4.5 0 0 0 7 18z" },
  ],
  Phone: [
    {
      d: "M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z",
    },
    { d: "M11 18.5h2" },
  ],
  Tablet: [
    {
      d: "M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z",
    },
    { d: "M11 18h2" },
  ],
  Monitor: [{ d: "M3 4h18v12H3z" }, { d: "M9 20h6M12 16v4" }],
  // A DESK MACHINE AND A HANDSET, not one screen. `Monitor` is a single
  // display, and the Devices destination lists every device paired to the
  // vault — a phone, a laptop, a tablet. One screen standing for a set of
  // screens is the kind of near-miss that reads as correct until you count
  // the things on the page it opens.
  Devices: [
    { d: "M9 17H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1v3" },
    {
      d: "M14 11h6a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z",
    },
    { d: "M7 21h4" },
  ],
  Command: [
    {
      d: "M9 7.5A2.5 2.5 0 1 0 6.5 10H10v4H6.5A2.5 2.5 0 1 0 9 16.5V13h6v3.5A2.5 2.5 0 1 0 17.5 14H14v-4h3.5A2.5 2.5 0 1 0 15 7.5V11H9z",
    },
  ],
  Share: [
    { d: "M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" },
    { d: "M16 6l-4-4-4 4M12 2v14" },
  ],
  Eye: [
    { d: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" },
    { d: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" },
  ],
  Code: [{ d: "M8 6l-6 6 6 6M16 6l6 6-6 6" }],
  History: [{ d: "M3 12a9 9 0 1 0 3-6.7L3 8" }, { d: "M3 3v5h5M12 7v5l3 2" }],
  Sparkle: [
    { d: "M12 3l1.8 4.7L18 9l-4.2 1.3L12 15l-1.8-4.7L6 9l4.2-1.3z" },
    { d: "M19 15l.6 1.6L21 17l-1.4.4L19 19l-.6-1.6L17 17l1.4-.4z" },
  ],
  MoreHoriz: [{ d: "M6 12h.01M12 12h.01M18 12h.01" }],
  MoreVert: [{ d: "M12 6h.01M12 12h.01M12 18h.01" }],
  Folder: [
    {
      d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    },
  ],
  // STORED RECORDS, not stored files. The Data destination is the vault's
  // structured store — rows a query answers from — and `Folder` is the mark
  // this product already spends on documents you filed yourself. Reusing it
  // here made two different destinations wear one glyph.
  Database: [
    { d: "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3z" },
    { d: "M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" },
    { d: "M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" },
  ],
  Paperclip: [
    {
      d: "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48",
    },
  ],
  FileEdit: [
    {
      d: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M14 3v6h6",
    },
    { d: "M18 13l3 3-5 5h-3v-3z" },
  ],
  Save: [
    { d: "M5 4h11l4 4v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" },
    { d: "M8 4v5h7V4M8 14h8v7H8z" },
  ],
  Settings: [
    {
      d: "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
    },
    { d: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" },
  ],

  // App-tile icons
  Todo: [
    {
      d: "M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z",
    },
    { d: "M8 10h8M8 14h5" },
    { d: "M7 10l1 1 2-2" },
  ],
  Habit: [
    {
      d: "M12 21s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 11c0 5.5-7 10-7 10z",
    },
  ],
  Journal: [
    { d: "M5 4a2 2 0 0 1 2-2h11v20H7a2 2 0 0 1-2-2z" },
    { d: "M9 8h6M9 12h6M9 16h4" },
  ],
  Pomodoro: [
    { d: "M20 13a8 8 0 1 1-16 0 8 8 0 0 1 16 0z" },
    { d: "M12 13l3-2M9 4h6M12 4V2" },
  ],
  Plant: [
    { d: "M12 22V11" },
    { d: "M12 11c-3 0-6-2-6-6 4 0 6 3 6 6z" },
    { d: "M12 14c3 0 6-2 6-6-4 0-6 3-6 6z" },
    { d: "M8 22h8" },
  ],
  Water: [
    { d: "M12 3l-5 7a6 6 0 0 0 10 0z" },
    { d: "M9.5 13a2.5 2.5 0 0 0 2.5 2.5" },
  ],
  Gift: [
    { d: "M3 9h18v12H3zM3 13h18M12 9v12" },
    {
      d: "M12 9c-2 0-4-1-4-3a2 2 0 0 1 4 0c0 2 0 3 0 3zM12 9c2 0 4-1 4-3a2 2 0 0 0-4 0c0 2 0 3 0 3z",
    },
  ],
  Mood: [
    { d: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" },
    { d: "M9 10v0M15 10v0" },
    { d: "M8.5 14.5a4 4 0 0 0 7 0" },
  ],
  Cellular: [
    {
      d: "M2 18v3h2v-3zM7 14v7h2v-7zM12 10v11h2V10zM17 6v15h2V6z",
      fill: "currentColor",
    },
  ],
  Wifi: [
    {
      d: "M5 12.5a10 10 0 0 1 14 0M2 8.5a15 15 0 0 1 20 0M8.5 16.5a5 5 0 0 1 7 0",
    },
    { d: "M12 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z", fill: "currentColor" },
  ],
  Battery: [
    { d: "M2 7h18v10H2z" },
    { d: "M4 9h10v6H4z", fill: "currentColor" },
    { d: "M22 11v2" },
  ],
  BatteryCharging: [
    { d: "M2 7h18v10H2z" },
    { d: "M22 11v2M11 10l-2 3h3l-1 3 4-5h-3l1-1z" },
  ],
  // Profile / space switcher glyphs.
  User: [
    { d: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" },
    { d: "M4.5 20.5a7.5 7.5 0 0 1 15 0" },
  ],
  Users: [
    { d: "M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" },
    { d: "M2.5 20.5a6.5 6.5 0 0 1 13 0" },
    { d: "M16.5 4.8a3.5 3.5 0 0 1 0 6.9M22 20.5a6.5 6.5 0 0 0-4.2-6.1" },
  ],
  SwitchVert: [{ d: "M8 4v16M8 20l-3-3M8 4l3 3M16 20V4M16 4l3 3M16 20l-3-3" }],
  UserPlus: [
    { d: "M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" },
    { d: "M2.5 20.5a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6" },
  ],
  Home: [{ d: "M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-7h-6v7H5a2 2 0 0 1-2-2z" }],
  Book: [
    { d: "M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z" },
    { d: "M4 17a2 2 0 0 1 2-2h13" },
  ],
  Music: [
    { d: "M9 18V5l11-2v13" },
    { d: "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" },
    { d: "M17 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" },
  ],
  Gym: [{ d: "M6 9v6M3 11v2M18 9v6M21 11v2M6 12h12" }],
  Calendar: [
    {
      d: "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
    },
    { d: "M3 10h18M8 3v4M16 3v4" },
  ],
  CalendarBlank: [
    {
      d: "M5 4h14a2 2 0 0 1 2 2v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2z",
    },
    { d: "M3 9h18" },
  ],
  CalendarPlus: [
    {
      d: "M5 4h14a2 2 0 0 1 2 2v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2z",
    },
    { d: "M3 9h18M12 12v6M9 15h6" },
  ],
  Camera: [
    {
      d: "M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    },
    { d: "M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" },
  ],
  EnvelopeSimple: [
    {
      d: "M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    },
    { d: "M3 7l9 6 9-6" },
  ],
  GitBranch: [
    { d: "M6 3v12a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V9" },
    {
      d: "M6 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
    },
  ],
  Lock: [{ d: "M5 10h14v10H5z" }, { d: "M8 10V7a4 4 0 0 1 8 0v3M12 14v2" }],
  PaperPlaneTilt: [{ d: "M22 2L11 13M22 2l-7 20-4-9-9-4z" }],
  Receipt: [
    { d: "M5 3h14v18l-3-2-4 2-4-2-3 2z" },
    { d: "M8 8h8M8 12h8M8 16h5" },
  ],

  // Automation glyphs (Automations redesign). Lucide-style, expressed as
  // <path> arcs/lines so the renderer's path-only wrapper can paint them at
  // the same stroke weight as the rest of the set.
  Clock: [{ d: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" }, { d: "M12 7v5l3 2" }],
  Webhook: [
    {
      d: "M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2",
    },
    { d: "M6 17l3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" },
    { d: "M12 6l3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 1 1-3.92 4.74" },
  ],
  Power: [{ d: "M12 2v10" }, { d: "M18.36 6.64a9 9 0 1 1-12.73 0" }],
  Stop: [
    {
      d: "M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z",
      fill: "currentColor",
    },
  ],
  AlertTriangle: [
    {
      d: "M21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z",
    },
    { d: "M12 9v4M12 17h.01" },
  ],
  AlertCircle: [
    { d: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" },
    { d: "M12 8v4M12 16h.01" },
  ],
  CheckCircle: [
    { d: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" },
    { d: "M8.5 12.5l2.5 2.5 4.5-5" },
  ],
  // Three-quarter arc so a CSS rotate animation reads as a spinner.
  Loader: [{ d: "M21 12a9 9 0 1 1-6.219-8.56" }],
  Filter: [{ d: "M22 3H2l8 9.46V19l4 2v-8.54z" }],
  Braces: [
    {
      d: "M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1",
    },
    {
      d: "M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1",
    },
  ],
  Gauge: [{ d: "M12 14l4-4" }, { d: "M3.34 19a10 10 0 1 1 17.32 0" }],
  Bell: [
    { d: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9z" },
    { d: "M10.3 21a1.94 1.94 0 0 0 3.4 0" },
  ],
  Key: [
    { d: "M12 15a4 4 0 1 1-8 0 4 4 0 0 1 8 0z" },
    { d: "M11 12l9-9" },
    { d: "M17 6l3 3M14 9l3 3" },
  ],
  Cpu: [
    {
      d: "M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
    },
    { d: "M9 9h6v6H9z" },
    { d: "M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" },
  ],
  Plug: [{ d: "M9 7V4M15 7V4M7 7h10v6a4 4 0 1 1-10 0z" }, { d: "M12 17v3" }],
  Sliders: [
    {
      d: "M21 4H14M10 4H3M21 12H12M8 12H3M21 20H16M12 20H3M14 2v4M8 10v4M16 18v4",
    },
  ],
  Beaker: [
    {
      d: "M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2z",
    },
    { d: "M8.5 2h7M7 16h10" },
  ],
  ChevronRight: [{ d: "M9 6l6 6-6 6" }],
  ChevronLeft: [{ d: "M15 6l-6 6 6 6" }],
  ChevronsDown: [{ d: "m7 7 5 5 5-5M7 13l5 5 5-5" }],
  Menu: [{ d: "M4 7h16M4 12h16M4 17h16" }],
  MessageCircle: [
    {
      d: "M20 11.5a7.5 7.5 0 0 1-8 7.5 8.5 8.5 0 0 1-4-.9L4 20l1.1-3.5A7.5 7.5 0 1 1 20 11.5z",
    },
  ],
  // Symmetric about x=12, the box's centre line, which is also where the point
  // at the bottom sits. The previous curve drew its lobes with their own centre
  // at x=9.25 while keeping the point at 12, so the glyph leaned left and its
  // right lobe collapsed into a notch — visible at every size.
  Heart: [
    {
      d: "M12 20s-7-4.4-7-9.4A3.8 3.8 0 0 1 12 8a3.8 3.8 0 0 1 7 2.6c0 5-7 9.4-7 9.4z",
    },
  ],
  Pin: [{ d: "M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6zM12 15v5" }],
  Image: [
    { d: "M3 5h18v14H3z" },
    { d: "M5 17l4-4 3 3 2-2 5 3" },
    { d: "M8 9h.01" },
  ],
  Grid: [{ d: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" }],
  // A PRINTER: the paper going in above, the machine, the sheet coming out.
  // Three subpaths and no fill, so it reads at 18px on the stage's near-black
  // the same way it reads at 15px in a menu on paper.
  Print: [
    { d: "M7 8V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v4" },
    {
      d: "M7 18H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2",
    },
    { d: "M7 14h10v6a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1z" },
  ],
  // A PAGE WITH ITS CORNER TURNED, and a table. The two glyphs a file browser
  // needs to say what a row holds without spelling the kind out in three
  // capital letters. `Archive` is a box and `Grid` is four detached squares —
  // neither reads as a document or as a sheet at 18px, which is why these are
  // their own entries rather than a reuse.
  FileText: [
    { d: "M6 3h7l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" },
    { d: "M13 3v5h5" },
  ],
  Table: [{ d: "M4 4h16v16H4z" }, { d: "M4 10h16M4 15h16M10 4v16" }],
  // The row menu's remaining three. A drive's kebab names Open, Details and
  // Tag among its verbs, and a menu where some items wear a glyph and others
  // wear a gap reads as a menu with something missing.
  OpenExternal: [
    { d: "M14 4h6v6" },
    { d: "M20 4 11 13" },
    { d: "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" },
  ],
  Tag: [{ d: "M4 11 11 4h8v8l-7 7z" }, { d: "M15.5 8.5h.01" }],
  Info: [
    { d: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" },
    { d: "M12 11v5" },
    { d: "M12 8h.01" },
  ],
  Layers: [{ d: "m12 3 9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 16l9 5 9-5" }],
  Maximize: [{ d: "M8 3H3v5M16 3h5v5M8 21H3v-5M21 16v5h-5" }],
  List: [{ d: "M4 6h16M4 12h16M4 18h16" }],
  Archive: [{ d: "M4 5h16v4H4z" }, { d: "M6 9v10h12V9M9 13h6" }],
  Upload: [{ d: "M12 15V3m0 0 4 4m-4-4-4 4M5 21h14" }],
  Download: [{ d: "M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" }],
  FolderPlus: [
    { d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9H3z" },
    { d: "M12 11v5M9.5 13.5h5" },
  ],
  Bookmark: [{ d: "M6 4h12v17l-6-3-6 3z" }],
  Shield: [{ d: "M12 3 20 6v5c0 5-3.4 8.7-8 10-4.6-1.3-8-5-8-10V6z" }],
  Smartphone: [
    {
      d: "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z",
    },
    { d: "M11 18h2" },
  ],
  EyeOff: [
    { d: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" },
    { d: "m4 4 16 16" },
  ],
  Sun: [
    {
      d: "M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4",
    },
    { d: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z" },
  ],
  Moon: [{ d: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" }],
  Repeat: [
    { d: "M17 2l4 4-4 4" },
    { d: "M3 11V9a4 4 0 0 1 4-4h14" },
    { d: "M7 22l-4-4 4-4" },
    { d: "M21 13v2a4 4 0 0 1-4 4H3" },
  ],
  Video: [{ d: "M3 6h14v12H3z" }, { d: "m17 10 4-3v10l-4-3" }],
  CirclePlus: [
    { d: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" },
    { d: "M12 8v8M8 12h8" },
  ],
  XCircle: [
    { d: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" },
    { d: "m9 9 6 6M15 9l-6 6" },
  ],

  // Photos v4 handoff (#711/#707, "New icon keys" — CHANGELOG v4 -
  // Photos.md §B2): the shelves, the selection set and the viewer bar. Same
  // contract as every other mark — single-tone stroke on a 24 grid, fill:
  // none, round caps and joins; the caller sets stroke-width (1.6, 1.75 below
  // 16px) and `aria-hidden` at render time. Lowercase keys match the
  // handoff's own key *names* — the handoff itself calls this path data
  // "placeholder stroke paths" (its "New icon keys this design needs" row),
  // not final artwork. None of the ten shared keys (album, dupe, heart,
  // info, person, place, removeFrom, restore, share, trash) is byte-for-byte
  // identical to the handoff's path data. `heart` carries the handoff's own
  // curve, which is symmetric about x=12 — lobes off-centre from the bottom
  // point lean the glyph and collapse the right lobe into a notch. The other
  // nine are a deliberate deviation, not an oversight:
  //   - `trash` and `share` reuse this file's app-wide `Trash`/`Share`
  //     artwork verbatim, so those glyphs look identical everywhere they
  //     appear instead of drawing a second, different-looking version for
  //     Photos alone.
  //   - `restore` deliberately does NOT reuse the handoff's generic circular
  //     undo-arrow: that arc shape is already `Reset`/`Refresh`/`History`
  //     below, and a fourth near-identical circular arrow under yet another
  //     name would be indistinguishable from those at a glance. It draws a
  //     trash can with an up-arrow instead — unambiguous for "bring this
  //     back from Recently Deleted."
  //   - `place` keeps its pin with an explicit ring instead of the handoff's
  //     pin, whose dot is a zero-length `M12 9.5v.01` — that only renders
  //     because of round line-caps, a guarantee react-native-svg does not
  //     make, so the handoff's own mark risks disappearing on mobile.
  //   - `removeFrom` keeps a self-contained circle-minus. The handoff's is a
  //     bare `M5 12h14` line with no circle; it is never actually wired to a
  //     button in the mockup (it appears only in the handoff's own "new icon
  //     keys" documentation row) and would read as nothing more than a
  //     horizontal divider without a circular button chrome around it that
  //     this codebase does not guarantee.
  //   - `album`, `dupe`, `info` and `person` differ in path data and/or
  //     subpath count (a photo-stack vs. a folder for `album`; a merged
  //     line+dot vs. three separate subpaths for `info`) but render as the
  //     same recognizable pictogram at 24px with no asymmetry or clipping.
  //     `person` also matches this file's `User` glyph exactly, again for
  //     cross-surface consistency rather than accident.
  // None of this claims parity with the handoff's path data — only that
  // each glyph reads correctly, and, where it deviates, why.
  heart: [
    {
      d: "M12 20s-7-4.4-7-9.4A3.8 3.8 0 0 1 12 8a3.8 3.8 0 0 1 7 2.6c0 5-7 9.4-7 9.4z",
    },
  ],
  album: [
    { d: "M4 7h13v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" },
    { d: "M7 4h13v13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4z" },
  ],
  place: [
    { d: "M12 21s7-7.58 7-12a7 7 0 0 0-14 0c0 4.42 7 12 7 12z" },
    { d: "M12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" },
  ],
  // Catalog automations use the Lucide name (`place-names` in index.json).
  // Same pin as `place` — not Lucide's zero-length-dot MapPin, which
  // react-native-svg may drop (see the `place` comment above).
  MapPin: [
    { d: "M12 21s7-7.58 7-12a7 7 0 0 0-14 0c0 4.42 7 12 7 12z" },
    { d: "M12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" },
  ],
  person: [
    { d: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" },
    { d: "M4.5 20.5a7.5 7.5 0 0 1 15 0" },
  ],
  dupe: [
    {
      d: "M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z",
    },
    { d: "M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" },
  ],
  trash: [
    {
      d: "M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M5 6l1 14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-14M10 11v6M14 11v6",
    },
  ],
  restore: [
    {
      d: "M4 7h16M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M8 7V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2",
    },
    { d: "M12 15V9M9 12l3-3 3 3" },
  ],
  add: [{ d: "M12 5v14M5 12h14" }],
  share: [
    { d: "M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" },
    { d: "M16 6l-4-4-4 4M12 2v14" },
  ],
  download: [{ d: "M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" }],
  removeFrom: [
    { d: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" },
    { d: "M8 12h8" },
  ],
  info: [
    { d: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" },
    { d: "M12 16v-4M12 8h.01" },
  ],
  more: [{ d: "M6 12h.01M12 12h.01M18 12h.01" }],
} as const;

export type IconName = keyof typeof ICON_DATA;
export const icons: Record<IconName, readonly IconPath[]> = ICON_DATA;

export type IconConcept =
  | "add"
  | "ask"
  | "back"
  | "close"
  | "leave"
  | "settings"
  | "trash"
  | "up";

export const ICON_CONCEPTS: Record<IconConcept, IconName> = {
  add: "Plus",
  ask: "Sparkle",
  back: "ArrowLeft",
  close: "X",
  leave: "Grid",
  settings: "Settings",
  trash: "Trash",
  up: "ChevronLeft",
};

export function isIconName(value: string): value is IconName {
  return Object.hasOwn(icons, value);
}

export function iconForConcept(concept: IconConcept): IconName {
  return ICON_CONCEPTS[concept];
}

/** Markup for one path entry — the seam the app-icon silhouette contract
 *  activates on: a path that declares `fillRule: "evenodd"` renders a real
 *  `fill-rule="evenodd"` attribute, so a future filled compound mark is
 *  enforceable on day one rather than needing a second pass through the
 *  renderer later. Exported so the contract test can exercise it directly
 *  without a shipped icon having to carry one first. */
export function pathMarkup(iconPath: IconPath): string {
  const fill =
    iconPath.fill === "currentColor"
      ? ' fill="currentColor" stroke="none"'
      : "";
  const fillRule =
    iconPath.fillRule === "evenodd" ? ' fill-rule="evenodd"' : "";
  return `<path d="${iconPath.d}"${fill}${fillRule}/>`;
}

export function iconPathMarkup(name: IconName): string {
  return icons[name].map(pathMarkup).join("");
}

export function iconSvg(
  name: IconName,
  options: { size?: number; strokeWidth?: number } = {}
): string {
  const size = options.size ?? 20;
  const strokeWidth = options.strokeWidth ?? 1.5;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${iconPathMarkup(name)}</svg>`;
}
