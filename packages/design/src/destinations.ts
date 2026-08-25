// Concept map of which glyph stands for which place — not the destination table.
// Shell (`launcherModel.ts`) and phone (`places.ts`) keep their own lists:
// ids disagree (`insights`/`stats`, `atlas`/`data`, `household`/`devices`) and
// each surface persists its own pin keys. Merging would orphan stored pin sets.
// Each surface maps its id here; a one-surface place simply has no entry.

import type { IconName } from "./icons";

/** A place named the way a member would name it — never by route or table row. */
export type DestinationConcept =
  | "analytics"
  | "assistant"
  | "automations"
  | "connectors"
  | "data"
  | "devices"
  | "gateway"
  | "home"
  | "notifications"
  | "settings"
  | "starred"
  | "storage";

export const DESTINATION_MARKS: Record<DestinationConcept, IconName> = {
  // Bars, not a pulse — `Activity` is liveness; Analytics is a settled reading.
  analytics: "BarChart2",
  assistant: "Sparkle",
  automations: "Bolt",
  connectors: "Plug",
  // Records, not files — `Folder` is already documents the member filed.
  data: "Database",
  // Desk machine AND handset — one monitor standing for a set of screens is wrong.
  devices: "Devices",
  gateway: "Cellular",
  home: "Home",
  notifications: "Bell",
  settings: "Settings",
  starred: "Star",
  storage: "Save",
};
