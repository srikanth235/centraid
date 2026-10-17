// Shared app identity; colorKey selects APP_HUES. Home has no hue.

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
    desc: "Notes, notebooks and a journal.",
    iconKey: "Book",
    id: "notes",
    name: "Notes",
  },
  {
    colorKey: "violet",
    desc: "Contacts and relationships.",
    iconKey: "AddressBook",
    id: "people",
    name: "People",
  },
  {
    colorKey: "amber",
    desc: "Browse and back up your photos.",
    iconKey: "Camera",
    id: "photos",
    name: "Photos",
  },
  {
    colorKey: "rose",
    desc: "Private items behind a lock.",
    iconKey: "Lock",
    id: "locker",
    name: "Locker",
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
    desc: "Your calendar, events and plans.",
    iconKey: "Calendar",
    id: "agenda",
    name: "Agenda",
  },
  {
    colorKey: "indigo",
    desc: "Spending, targets and cash flow.",
    iconKey: "Coin",
    id: "money",
    name: "Money",
  },
];

export const apps: readonly AppMetaResolved[] = BUILTIN_APPS.map((a) => ({
  ...a,
  color: palette[a.colorKey],
}));
