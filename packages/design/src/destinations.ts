// Shared glyph concepts; surface-specific destination IDs retain their pin keys.

import type { IconName } from "./icons";

/** Glyph concepts; surface labels and persisted pin keys remain surface-owned (#1015). */
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
