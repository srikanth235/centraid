import type { IconName } from "./icons";

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
  analytics: "BarChart2",
  assistant: "Sparkle",
  automations: "Bolt",
  connectors: "Plug",
  data: "Database",
  devices: "Devices",
  gateway: "Cellular",
  home: "Home",
  notifications: "Bell",
  settings: "Settings",
  starred: "Star",
  storage: "Save",
};
