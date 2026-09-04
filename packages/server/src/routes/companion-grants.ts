export const COMPANION_MODULES = [
  "locker",
  "tasks",
  "notes",
  "docs",
  "agenda",
  "people",
] as const;

export type CompanionModule = (typeof COMPANION_MODULES)[number];
/**
 * `parked` LEFT this vocabulary with the app grant plane (#928 A1). A
 * first-party app is not a principal: it does not wait for an answer, so
 * "installed but not yet granted" is a state that can no longer occur. What
 * remains are the two facts the companion seat actually has — whether the
 * owner selected the module, and whether its app is installed here.
 */
export type CompanionModuleState = "granted" | "revoked" | "unavailable";

/** A module goes dark as soon as the owner drops it from the companion set. */
export function companionModuleState(
  selected: ReadonlySet<string>,
  module: CompanionModule,
  installed: boolean
): CompanionModuleState {
  if (!selected.has(module)) return "revoked";
  return installed ? "granted" : "unavailable";
}
