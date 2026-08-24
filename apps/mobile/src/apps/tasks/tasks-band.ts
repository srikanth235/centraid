// The phone's bottom band, as Tasks claims it (Tasks spec §2; issue #834).
//
// `Today · Upcoming · Inbox · Projects · More` — four PLACES plus More, which is
// the invariant's exact cap. Only a place is in the band: Anytime, All, Search,
// the Logbook, Catch up and Reminders are lenses or acts, so they sit behind
// More rather than stealing a tab from somewhere a member actually goes.
//
// THE IDS AND THE LABELS ARE THE WEB APP'S OWN. They are imported from
// `@centraid/blueprints/apps/tasks/shelves` and `view-copy` rather than
// re-typed here, because the band, the rail and the app bar must be incapable
// of disagreeing about what "Inbox" is — one table, two seats.
//
// This module is deliberately free of `react-native` imports so its rules can
// be asserted directly (`tasks-band.test.ts`). `TasksBand.tsx` renders them and
// adds nothing.

import {
  BAND_DESTINATIONS,
  MORE_SHELVES,
} from "@centraid/blueprints/apps/tasks/shelves";
import type { ShelfId } from "@centraid/blueprints/apps/tasks/shelves";
import { MORE_ROWS } from "@centraid/blueprints/apps/tasks/view-copy";

import type { BandOwner } from "../../kit/band/band-owner";

export type TasksBandDestinationKey =
  | "today"
  | "upcoming"
  | "inbox"
  | "projects"
  | "more";

export interface TasksBandDestination {
  key: TasksBandDestinationKey;
  /** Copy is final — these five strings ARE the band. */
  label: string;
  icon: string;
}

/** The cap the frame's band lives under, and therefore the cap a claiming app
 *  lives under: five destinations, of which the fifth is More. */
export const TASKS_BAND_MAX_DESTINATIONS = 5;

/** The frame capsule's width (height comes from the row's `align-items:
 *  stretch`, the same as Photos and Docs). */
export const TASKS_BAND_CAPSULE_SIZE = 52;

const BAND_ICONS: Readonly<Record<TasksBandDestinationKey, string>> = {
  today: "Check",
  upcoming: "Clock",
  inbox: "Inbox",
  projects: "Folder",
  more: "more-vertical",
};

/** Tasks' five, in the spec's order — the web app's own four destinations plus
 *  the sheet. A key that is not one of the four fails to typecheck here rather
 *  than rendering a tab that goes nowhere. */
export const TASKS_BAND_DESTINATIONS: readonly TasksBandDestination[] = [
  ...BAND_DESTINATIONS.map((destination) => ({
    key: destination.id as TasksBandDestinationKey,
    label: destination.label,
    icon: BAND_ICONS[destination.id as TasksBandDestinationKey],
  })),
  { key: "more", label: "More", icon: BAND_ICONS.more },
];

/** The frame's capsule — a frame control, never one of the app's tabs. */
export interface TasksBandCapsule {
  label: "Home";
  icon: "Home";
  size: number;
  edge: "leading";
  /** The seam. `false` is the whole reason it is not a sixth tab. */
  inTabGroup: false;
}

export const TASKS_BAND_CAPSULE: TasksBandCapsule = {
  label: "Home",
  icon: "Home",
  size: TASKS_BAND_CAPSULE_SIZE,
  edge: "leading",
  inTabGroup: false,
};

/** Exactly one band exists at any moment — the frame's latch, per app. */
export type ResolvedTasksBand =
  | {
      owner: "app";
      destinations: readonly TasksBandDestination[];
      capsule: TasksBandCapsule;
    }
  | { owner: "host" };

export function resolveTasksBand(owner: BandOwner): ResolvedTasksBand {
  if (owner === "host") return { owner: "host" };
  if (TASKS_BAND_DESTINATIONS.length > TASKS_BAND_MAX_DESTINATIONS) {
    throw new Error(
      `Tasks claimed ${TASKS_BAND_DESTINATIONS.length} band destinations; the cap is ${TASKS_BAND_MAX_DESTINATIONS}`
    );
  }
  return {
    owner: "app",
    destinations: TASKS_BAND_DESTINATIONS,
    capsule: TASKS_BAND_CAPSULE,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// The More sheet — the six lenses and acts that are not places
// ───────────────────────────────────────────────────────────────────────────

export interface TasksMoreRow {
  shelf: ShelfId;
  label: string;
  meta?: string;
  icon: string;
}

const MORE_ICONS: readonly string[] = [
  "Inbox",
  "FileText",
  "Search",
  "Check",
  "Clock",
  "Bell",
];

/** The sheet's rows, keyed to the SHARED shelf ids so the labels and the meta
 *  stay the web app's words rather than a second spelling of them. */
export const TASKS_MORE_ROWS: readonly TasksMoreRow[] = MORE_SHELVES.map(
  (shelf, index) => {
    const row = MORE_ROWS.find((candidate) => candidate.shelf === shelf);
    if (!row) throw new Error(`No shared More row for shelf ${String(shelf)}`);
    return {
      shelf,
      label: row.label,
      icon: MORE_ICONS[index] ?? "more-vertical",
      ...(row.meta ? { meta: row.meta } : {}),
    };
  }
);
