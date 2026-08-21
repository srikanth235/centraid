// Built-in product catalog — the shipped blueprint apps, not demo placeholders.
// Shared across desktop + mobile so launcher identity cannot drift by client.
//
// `colorKey` names the app's slot on the identity hue wheel (`APP_HUES` in
// palette.ts). The Binding Layer assigns them by content character, not by
// taste: locker 0 (rose), photos 28 (amber), tasks 70 (ochre), agenda 150
// (forest), docs 210 (teal), notes 255 (slate), tally 290 (indigo), people
// 320 (violet). Home takes no hue at all — it renders in `--text-soft`.

import type { IconName } from "./icons";
import { palette } from "./palette";
import type { ColorHex, ColorKey } from "./palette";

export interface AppMeta {
  id: string;
  name: string;
  colorKey: ColorKey;
  iconKey: IconName;
  desc: string;
}

export interface AppMetaResolved extends AppMeta {
  color: ColorHex;
}

const BUILTIN_APPS: readonly AppMeta[] = [
  {
    colorKey: "slate",
    desc: "Write and revisit durable notes.",
    iconKey: "Book",
    id: "notes",
    name: "Notes",
  },
  {
    colorKey: "violet",
    desc: "Keep people and relationships close.",
    iconKey: "AddressBook",
    id: "people",
    name: "People",
  },
  {
    colorKey: "amber",
    desc: "Browse and protect your photos.",
    iconKey: "Camera",
    id: "photos",
    name: "Photos",
  },
  {
    colorKey: "rose",
    desc: "Keep private secrets behind a lock.",
    iconKey: "Lock",
    id: "locker",
    name: "Locker",
  },
  {
    colorKey: "indigo",
    desc: "See balances and simple trends.",
    iconKey: "Receipt",
    id: "tally",
    name: "Tally",
  },
  {
    colorKey: "ochre",
    desc: "Capture the next thing to do.",
    iconKey: "Check",
    id: "tasks",
    name: "Tasks",
  },
  {
    colorKey: "teal",
    desc: "Read and organize your documents.",
    iconKey: "Folder",
    id: "docs",
    name: "Docs",
  },
  {
    colorKey: "forest",
    desc: "Keep dates, events, and plans together.",
    iconKey: "Calendar",
    id: "agenda",
    name: "Agenda",
  },
];

export const apps: readonly AppMetaResolved[] = BUILTIN_APPS.map((a) => ({
  ...a,
  color: palette[a.colorKey],
}));
