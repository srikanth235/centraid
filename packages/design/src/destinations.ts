// Concept map of which glyph stands for which place — not the destination table.
// Shell (`launcherModel.ts`) and phone (`places.ts`) keep their own lists:
// ids disagree (`insights`/`stats`, `atlas`/`data`, `household`/`devices`) and
// each surface persists its own pin keys. Merging would orphan stored pin sets.
// Each surface maps its id here; a one-surface place simply has no entry.

import type { IconName } from "./icons";

/**
 * The ID of a place's glyph concept — NOT the member's word for it (#1015,
 * R-SH-12). Three keys already diverge from what the surfaces print
 * (`analytics` is "Activity", `data` is "Vault", `devices` is "Household"),
 * and `automations` is "Rules" on both seats; the label lives in
 * `launcherModel.ts` / `places.ts`, which is the only place it may live.
 */
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
