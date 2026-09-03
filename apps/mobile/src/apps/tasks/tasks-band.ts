import {
  BAND_DESTINATIONS,
  MORE_SHELVES,
} from "@centraid/blueprints/apps/tasks/shelves";
import type { ShelfId } from "@centraid/blueprints/apps/tasks/shelves";
import { MORE_ROWS } from "@centraid/blueprints/apps/tasks/view-copy";

import { BAND_CAPSULE } from "../../kit/band/band-capsule";
import type { BandCapsule } from "../../kit/band/band-capsule";
import type { BandOwner } from "../../kit/band/band-owner";

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
  label: string;
  icon: string;
}

export const TASKS_BAND_MAX_DESTINATIONS = 5;

const BAND_ICONS: Readonly<Record<TasksBandDestinationKey, string>> = {
  today: "Check",
  upcoming: "Clock",
  inbox: "Inbox",
  projects: "Folder",
  more: "more-vertical",
};

export const TASKS_MORE_LABEL = "More";

export const TASKS_BAND_DESTINATIONS: readonly TasksBandDestination[] = [
  ...BAND_DESTINATIONS.map((destination) => ({
    key: destination.id as TasksBandDestinationKey,
    label: destination.label,
    icon: BAND_ICONS[destination.id as TasksBandDestinationKey],
  })),
  { key: "more", label: TASKS_MORE_LABEL, icon: BAND_ICONS.more },
];

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
