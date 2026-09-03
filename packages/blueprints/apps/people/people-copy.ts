export const APP_TITLE = "People";
export const TOUCH_TITLE = "Touch";
export const SEARCH_TITLE = "Search";

export const VERBS = {
  add: "Add",
  addPerson: "Add person",
  cancel: "Cancel",
  clearSearch: "Clear search",
  edit: "Edit",
  log: "Log",
  merge: "Merge",
  merged: "Merged",
  mute: "Mute",
  remind: "Remind",
  remove: "Remove",
  restore: "Restore",
  save: "Save",
  share: "Share",
  trash: "Trash",
  undo: "Undo",
} as const;

export const FILTER_CHIPS = [
  { id: "all", label: "All" },
  { id: "linked", label: "Linked" },
  { id: "unlinked", label: "Unlinked" },
  { id: "starred", label: "★" },
  { id: "due", label: "Overdue" },
] as const;

const LINK_CHIP_IDS: readonly string[] = ["linked", "unlinked"];

export function filterChips(
  linksAvailable: boolean
): readonly { id: string; label: string }[] {
  if (linksAvailable) return FILTER_CHIPS;
  return FILTER_CHIPS.filter((chip) => !LINK_CHIP_IDS.includes(chip.id));
}

export const TOUCH_TILES = [
  { id: "all", label: "People", net: false },
  { id: "reconnect", label: "Reconnect", net: true },
  { id: "upcoming", label: "Upcoming", net: true },
  { id: "starred", label: "Starred", net: false },
] as const;

export const LINK_TOUCH_TILES = [
  { id: "linked", label: "Vaults", net: false },
  { id: "to_link", label: "To link", net: true },
  { id: "reconnect", label: "Reconnect", net: true },
  { id: "upcoming", label: "Upcoming", net: false },
] as const;

export const SECTIONS = {
  reconnect: "Reconnect",
  upcoming: "Upcoming",
  recent: "Recent",
  vaults: "Vaults",
  shared: "Shared with them",
  channels: "Channels",
  dates: "Dates",
  notes: "Notes",
  result: "Result",
} as const;

export const LINK = {
  linked: "Linked",
  vaultRow: "Linked vault",
  linkedWhen: (when: string) => `linked ${when.toLowerCase()}`,
  inviteRow: "Invitation sent",
  inviteWaiting: "waiting to be accepted",
  sharedSince: (capability: string, when: string) =>
    `${capability} · since ${when.toLowerCase()}`,
} as const;

export const LOG_KINDS = ["Message", "Call", "Met up", "Note"] as const;

export const CADENCE_CHIPS = [0, 7, 14, 30, 90] as const;

export const CADENCE_NEVER = "Never";

export const FIELDS = {
  name: "Name",
  role: "Role",
  rolePlaceholder: "One line",
  colour: "Colour",
  cadence: "Reach out every",
  note: "Note",
  notePlaceholder: "Optional",
  searchPlaceholder: "Search names, roles, notes",
  dateLabel: "Label",
  date: "Date",
  datePlaceholder: "MM-DD",
} as const;

export const FRAGMENTS = {
  preferred: "preferred",
  reminderOn: "reminder on",
  reminderOff: "reminder off",
  daysLeft: (days: number) =>
    days <= 0 ? "Today" : `${days} ${days === 1 ? "day" : "days"} left`,
  was: (field: string, value: string) => `${field} · was ${value}`,
} as const;

export const MERGE_HEADS = {
  keep: "Keep",
  mergeIn: "Merge in",
} as const;

export const EMPTY = {
  roster: "Nobody here yet.",
  noMatch: "Nothing matches.",
  searchIdle: "Type to search.",
  reconnect: "Nobody is overdue.",
  upcoming: "No dates coming up.",
  recent: "Nothing logged yet.",
  vaults: "Not linked yet.",
  channels: "No channels.",
  dates: "No dates.",
  notes: "No notes.",
  trash: "Trash is empty.",
  merge: "Nobody to merge in.",
} as const;

export const FIRST_RUN = {
  title: "Add the people you keep up with",
  body: "Add someone, set how often to reach out, and log a touch each time you do.",
  action: VERBS.addPerson,
} as const;

export const SENTENCES = {
  mergeWarning: "Merging cannot be undone.",
  shareStartsWhereItLives: "A share starts in the app that holds the thing.",
  merged: "Merged.",
  trashPurge: "Erased after 30 days.",
} as const;

export const CONFIRMS = {
  trash: {
    title: (name: string) => `Move ${name} to trash?`,
    body: "Restorable for 30 days.",
    verb: VERBS.trash,
  },
  merge: {
    title: (dupe: string, keep: string) => `Merge ${dupe} into ${keep}?`,
    body: SENTENCES.mergeWarning,
    verb: VERBS.merge,
  },
} as const;

export const STATUS = {
  roster: (people: number, due: number, starred: number, truncated = false) =>
    truncated
      ? `${people} people shown · ${due} to reconnect · ${starred} starred`
      : `${people} people · ${due} to reconnect · ${starred} starred`,
  rosterLinked: (
    linked: number,
    people: number,
    toLink: number,
    due: number,
    starred: number,
    truncated = false
  ) =>
    truncated
      ? `${linked} vaults across ${people} people shown · ${toLink} to link · ${due} to reconnect · ${starred} starred`
      : `${linked} vaults across ${people} people · ${toLink} to link · ${due} to reconnect · ${starred} starred`,
  barLinked: (linked: number, people: number) =>
    `${linked} of ${people} linked`,
  touch: (people: number, due: number) => `${people} people · ${due} overdue`,
  touchLinked: (linked: number, toLink: number, due: number) =>
    `${linked} vaults · ${toLink} to link · ${due} overdue`,
  searchResting: "Searches names, roles and notes",
  searchResults: (matched: number, total: number) =>
    `${matched} of ${total} match`,
  searchUnreachable: "Search could not be reached.",
  logging: "Logging stamps last contacted",
  editing: "Nothing is written until you save",
  trash: (count: number) => `${count} in trash · ${SENTENCES.trashPurge}`,
} as const;

export const OUTCOMES = {
  added: (name: string) => `${name} added`,
  edited: (name: string) => `${name} edited`,
  cadence: (name: string) => `Cadence set · ${name}`,
  logged: (kind: string, name: string) => `${kind} logged · ${name}`,
  noted: (name: string) => `Note added · ${name}`,
  dated: (name: string) => `Date added · ${name}`,
  reminderOn: (label: string) => `Reminder on · ${label}`,
  reminderOff: (label: string) => `Reminder off · ${label}`,
  starred: (name: string) => `${name} starred`,
  unstarred: (name: string) => `Star removed · ${name}`,
  trashed: (name: string) => `${name} moved to trash`,
  restored: (name: string) => `${name} restored`,
  channelSaved: (kind: string) => `${kind} saved`,
  channelRemoved: (kind: string) => `${kind} removed`,
  merged: (dupe: string, keep: string) => `${dupe} merged into ${keep}`,
} as const;

export const REFUSALS = {
  denied: "The vault refused that write.",
  parked: "Waiting for approval.",
  queued: "Queued on this device.",
  failed: "That write did not land.",
  readFailed: "The vault is out of reach.",
} as const;

export const LABELS = {
  star: (name: string) => `Star ${name}`,
  unstar: (name: string) => `Unstar ${name}`,
  removeChannel: (kind: string) => `Remove ${kind}`,
  openPerson: (name: string) => `Open ${name}`,
  logFor: (name: string) => `Log a touch with ${name}`,
  collapse: (section: string) => `${section} section`,
  colour: (hue: string) => `Colour ${hue}`,
  destinations: "People destinations",
} as const;
