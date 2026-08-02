// Built-in product catalog — the shipped blueprint apps, not demo placeholders.
// Shared across desktop + mobile so launcher identity cannot drift by client.

import type { IconName } from "./icons";
import { palette } from "./palette";
import type { ColorKey, ColorHex } from "./palette";

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
    colorKey: "amber",
    desc: "Write and revisit durable notes.",
    iconKey: "Book",
    id: "notes",
    name: "Notes",
  },
  {
    colorKey: "rose",
    desc: "Keep people and relationships close.",
    iconKey: "AddressBook",
    id: "people",
    name: "People",
  },
  {
    colorKey: "teal",
    desc: "Browse and protect your photos.",
    iconKey: "Camera",
    id: "photos",
    name: "Photos",
  },
  {
    colorKey: "violet",
    desc: "Keep private secrets behind a lock.",
    iconKey: "Lock",
    id: "locker",
    name: "Locker",
  },
  {
    colorKey: "forest",
    desc: "See balances and simple trends.",
    iconKey: "Receipt",
    id: "tally",
    name: "Tally",
  },
  {
    colorKey: "indigo",
    desc: "Capture the next thing to do.",
    iconKey: "Check",
    id: "tasks",
    name: "Tasks",
  },
  {
    colorKey: "ochre",
    desc: "Read and organize your documents.",
    iconKey: "Folder",
    id: "docs",
    name: "Docs",
  },
  {
    colorKey: "slate",
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
