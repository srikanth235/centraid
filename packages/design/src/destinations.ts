// The mark each frame destination wears.
//
// WHY THIS IS A CONCEPT MAP AND NOT THE DESTINATION TABLE ITSELF.
//
// The shell and the phone each keep their own list of places — the shell's in
// `packages/client/src/react/shell/launcherModel.ts`, the phone's in
// `apps/mobile/src/screens/home/places.ts` — and those lists are NOT
// duplicates that want merging. Each entry carries surface-specific facts the
// other surface has no use for: the shell's `route` is a `ShellRoute` and its
// `id` is a `ShellPage`, which is both the router's key and the value
// PERSISTED IN A MEMBER'S PIN SET; the phone's entry carries `law`, `pin` and
// the one-line `what` its All-places sheet reads out. The two even disagree on
// the ids — `insights`/`stats`, `atlas`/`data`, `household`/`devices` — so a
// single shared table would have to rename one side's ids, which would orphan
// every stored pin set and re-point routes. That is a migration, not a tidy-up.
//
// What the two lists genuinely share is the part a reader can see: WHICH GLYPH
// STANDS FOR WHICH PLACE. That is a design fact, it belongs here, and until it
// lived here the two lists drifted exactly the way you would expect — Analytics
// wore the liveness pulse on both surfaces, Data wore the documents folder, and
// Devices wore a single monitor, each wrong in both places and each needing two
// edits to fix.
//
// Each surface keeps its own id and maps it to a concept below. A destination
// that changes its mark now changes it once, everywhere, and a destination that
// exists on only one surface simply has no entry.

import type { IconName } from "./icons";

/** A place in the frame, named the way a member would name it — never by the
 *  route that reaches it or the table row that stores it. */
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
  // Bars, not a pulse. `Activity` is the mark for liveness — something
  // happening right now — and Analytics is its opposite: a settled reading of
  // what already did.
  analytics: "BarChart2",
  assistant: "Sparkle",
  automations: "Bolt",
  connectors: "Plug",
  // Stored RECORDS, not stored files. `Folder` is already spent on documents
  // a member filed themselves; the vault's structured store is a different
  // thing and cannot wear the same glyph.
  data: "Database",
  // A desk machine AND a handset. This destination lists every device holding
  // a copy, and one screen standing for a set of screens reads as correct
  // right up until you count the rows on the page it opens.
  devices: "Devices",
  gateway: "Cellular",
  home: "Home",
  notifications: "Bell",
  settings: "Settings",
  starred: "Star",
  storage: "Save",
};
