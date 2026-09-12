// EVERY STRING PEOPLE PUTS ON SCREEN, so a component cannot mint copy; the
// budgets are DESIGN.md § Copy. `Share` and `Revoke` take their words from the
// shared kit (#825) and are never restated. `Link vault` has no copy: linking
// is not an act a member performs.
import { plural } from "../_shared/format-kit.ts";

export const APP_TITLE = "People";

/**
 * WHAT A PUSHED ROUTE IS CALLED (#1015 S2). Every pushed screen in People used
 * to draw a back row and nothing else, so Trash and the new-person form were
 * indistinguishable at a glance — both headed `‹ People` with no title at all.
 */
export const ROUTE_TITLES = {
  trash: "Trash",
  newPerson: "New person",
  editPerson: "Edit person",
  merge: "Merge",
  logTouch: "Log a touch",
} as const;
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
  /** THE PLACE AND THE ACT ARE NOT ONE WORD (#1015, people/findings #3). The
   *  roster header's `Trash` means "go to the bin" and the person screen's
   *  meant "destroy this person" — same word, same outline, one screen apart,
   *  the only difference a red border. The act says what it does; the place
   *  keeps the noun. */
  moveToTrash: "Move to trash",
  undo: "Undo",
} as const;

export const FILTER_CHIPS = [
  { id: "all", label: "All" },
  { id: "linked", label: "Linked" },
  { id: "unlinked", label: "Unlinked" },
  // A CHIP IS ANNOUNCED BY ITS LABEL (#1015, people/findings #9/#15): `★` was
  // the whole accessible name, so VoiceOver read a symbol with no verb.
  { id: "starred", label: "Starred" },
  { id: "due", label: "Overdue" },
] as const;

const LINK_CHIP_IDS: readonly string[] = ["linked", "unlinked"];

/** Unreadable link facts DROP the chips: empty reads as "nobody". */
export function filterChips(
  linksAvailable: boolean
): readonly { id: string; label: string }[] {
  if (linksAvailable) return FILTER_CHIPS;
  return FILTER_CHIPS.filter((chip) => !LINK_CHIP_IDS.includes(chip.id));
}

export const TOUCH_TILES = [
  { id: "all", label: "People", net: false },
  { id: "reconnect", label: "Reconnect", net: true },
  // `--net` is the colour of a CONSEQUENCE (DESIGN.md). Two birthdays is not
  // one, and the same red carries "overdue" and the read-only refusal two
  // screens away, so the tile read as an alert (people/findings #8). The
  // linked tile set already said `net: false` for the same fact.
  { id: "upcoming", label: "Upcoming", net: false },
  { id: "starred", label: "Starred", net: false },
] as const;

/** `Vaults` counts LINKED PEOPLE: at most one live binding per party. */
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

/** Rows say `Linked vault`, never a vault id: an id is not a name. */
export const LINK = {
  linked: "Linked",
  vaultRow: "Linked vault",
  linkedWhen: (when: string) => `linked ${when.toLowerCase()}`,
  sharedSince: (capability: string, when: string) =>
    `${capability} · since ${when.toLowerCase()}`,
} as const;

// A grant's subject is named by `grantNoun` (#825), never worded here.

/** The vault stores the word. */
export const LOG_KINDS = ["Message", "Call", "Met up", "Note"] as const;

/**
 * THE TWO KIND TABLES (#1015 Wave 3, S11; people/findings #12). The app used
 * the stored enum as its own label in three places — the channel composer's
 * chips and field label read `phone`, `email`, `handle` in lowercase, and
 * Touch's Recent sub-lines read `message`, `visit`, `call` — while the Log
 * screen's chips said `Message · Call · Met up · Note`. So one event appeared
 * as `Met up` on the screen that recorded it and `visit` on the screen that
 * lists it, and every other label in the app is sentence case.
 *
 * A label is a presentation of an enum: the writers and the readers of a kind
 * both come through these, and an unrecognised value is shown as itself rather
 * than hidden, because a value the vault holds is a fact.
 */
export const CHANNEL_KIND_LABEL: Readonly<Record<string, string>> = {
  phone: "Phone",
  email: "Email",
  handle: "Handle",
};

export function channelKindLabel(kind: string): string {
  return CHANNEL_KIND_LABEL[kind] ?? kind;
}

/** Both spellings of a touch kind — the word this seat writes and the word an
 *  older or another writer stored — land on one member-facing noun. */
export const TOUCH_KIND_LABEL: Readonly<Record<string, string>> = {
  message: "Message",
  call: "Call",
  visit: "Met up",
  "met up": "Met up",
  note: "Note",
};

export function touchKindLabel(kind: string): string {
  return TOUCH_KIND_LABEL[kind.toLowerCase()] ?? kind;
}

/** `Never` IS THE ZERO: zero is never overdue (`format.ts` isOverdue). */
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
  /** The `Result` row's second line: the surviving value, and what it replaced
   *  where the duplicate held something else (#1015, people/findings #13). The
   *  FIELD is the row's top line, like every other row in this app. */
  was: (kept: string, replaced: string) => `${kept} · was ${replaced}`,
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
  /** People keeps people: there is no subject of its own to share. */
  shareStartsWhereItLives: "A share starts in the app that holds the thing.",
  merged: "Merged.",
  trashPurge: "Erased after 30 days.",
} as const;

/** Revoke is the KIT'S confirm, word for word — never restated here. */
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
  /** A channel has no reverse write, so it joins Trash and Merge on the modal
   *  rather than on the status line's Undo (#1015, people/findings #7). The
   *  `✕` used to destroy the row on one tap, from a 44pt target sitting beside
   *  the row's own open-the-person target. */
  removeChannel: {
    title: (kind: string) => `Remove this ${kind}?`,
    body: "There is no undo for this one.",
    verb: VERBS.remove,
  },
} as const;

/** Never a zero standing in for a number nobody could see. */
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
  /** Roster app-bar meta on a pointer surface. */
  barLinked: (linked: number, people: number) =>
    `${linked} of ${people} linked`,
  touch: (people: number, due: number) => `${people} people · ${due} overdue`,
  touchLinked: (linked: number, toLink: number, due: number) =>
    `${linked} vaults · ${toLink} to link · ${due} overdue`,
  searchResting: "Searches names, roles and notes",
  /** `1 of 7 match` was ungrammatical at every count (people/findings #11). */
  searchResults: (matched: number, total: number) =>
    matched === 0
      ? `No matches in ${plural(total, "person", "people")}`
      : `${String(matched)} of ${plural(total, "person", "people")}`,
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

/** A denial, a park and a queue are three facts; each keeps its sentence. */
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
