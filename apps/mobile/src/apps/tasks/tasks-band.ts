// The phone's bottom band, as Tasks claims it (Tasks spec §2; #834): four
// PLACES plus More — the invariant's exact cap; lenses/acts sit behind More.
// Ids+labels come from the web app's tables so band, rail and app bar cannot
// disagree. No `react-native` imports: `tasks-band.test.ts` asserts these
// rules directly; `TasksBand.tsx` renders them unchanged.

import {
  BAND_DESTINATIONS,
  MORE_SHELVES,
} from "@centraid/blueprints/apps/tasks/shelves";
import type { ShelfId } from "@centraid/blueprints/apps/tasks/shelves";
import { MORE_ROWS } from "@centraid/blueprints/apps/tasks/view-copy";

import { BAND_CAPSULE } from "../../kit/band/band-capsule";
import type { BandCapsule } from "../../kit/band/band-capsule";
import type { BandOwner } from "../../kit/band/band-owner";

// The frame's capsule lives in `kit/band/band-capsule.ts` (#883 B5).
export { BAND_CAPSULE } from "../../kit/band/band-capsule";
export type { BandCapsule } from "../../kit/band/band-capsule";

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

/** Frame band's cap, hence a claiming app's: five destinations, fifth = More. */
export const TASKS_BAND_MAX_DESTINATIONS = 5;

const BAND_ICONS: Readonly<Record<TasksBandDestinationKey, string>> = {
  today: "Check",
  upcoming: "Clock",
  inbox: "Inbox",
  projects: "Folder",
  more: "more-vertical",
};

export const TASKS_MORE_LABEL = "More";

/** Tasks' five in spec order: web's four destinations plus the sheet. */
export const TASKS_BAND_DESTINATIONS: readonly TasksBandDestination[] = [
  ...BAND_DESTINATIONS.map((destination) => ({
    key: destination.id as TasksBandDestinationKey,
    label: destination.label,
    icon: BAND_ICONS[destination.id as TasksBandDestinationKey],
  })),
  { key: "more", label: TASKS_MORE_LABEL, icon: BAND_ICONS.more },
];

/** Exactly one band exists at any moment — the frame's latch. */
export type ResolvedTasksBand =
  | {
      owner: "app";
      destinations: readonly TasksBandDestination[];
      capsule: BandCapsule;
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
    capsule: BAND_CAPSULE,
  };
}

// ─── The More sheet — the six lenses and acts that are not places ───────────

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

/** Rows keyed to SHARED shelf ids: labels stay the web app's words. */
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
