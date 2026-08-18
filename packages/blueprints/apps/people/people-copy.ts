// EVERY STRING PEOPLE PUTS ON SCREEN. One module, so a component cannot mint
// copy and the whole inventory can be read in one sitting — the same shape
// `docs/view-copy.ts` gives Docs.
//
// WHAT THE HANDOFF ASKED FOR AND THIS APP DOES NOT SAY. The v12 handoff's
// copy inventory is written around the VAULT LINK — linked/unlinked chips, a
// `Link` verb on a row, a Share sheet, vault tags, and status lines that count
// vaults. No People query returns a vault link or a share receipt, and a
// design handoff redraws screens rather than redesigning the vault contract,
// so none of that copy exists here: the strings that counted vaults count
// people, and the strings that named a link name nothing. When the link
// contract lands, its copy is added here rather than improvised at a call
// site.
//
// Budgets (DESIGN.md § Copy): a label is a verb-first fragment, an empty state
// or a banner is ONE sentence, nothing exceeds 120 characters, and "please",
// "successfully", "simply", "in order to", "you can" and "we're sorry" appear
// nowhere.

/** The app's own name, and the three band destinations. */
export const APP_TITLE = "People";
export const TOUCH_TITLE = "Touch";
export const SEARCH_TITLE = "Search";

/** Verbs. Two words at most, the object named wherever a screen has one. */
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
  trash: "Trash",
  undo: "Undo",
} as const;

/** The roster's filter chips. `Linked` and `Unlinked` are absent for the
 *  reason at the top of this file: nothing answers them. */
export const FILTER_CHIPS = [
  { id: "all", label: "All" },
  { id: "starred", label: "★" },
  { id: "due", label: "Overdue" },
] as const;

/** The Touch screen's four count tiles, in order. `Reconnect` and `Upcoming`
 *  take the consequence tone while they are above zero — they are the two
 *  that ask for something. */
export const TOUCH_TILES = [
  { id: "all", label: "People", net: false },
  { id: "reconnect", label: "Reconnect", net: true },
  { id: "upcoming", label: "Upcoming", net: true },
  { id: "starred", label: "Starred", net: false },
] as const;

/** Touch's three sections, and the person screen's four. */
export const SECTIONS = {
  reconnect: "Reconnect",
  upcoming: "Upcoming",
  recent: "Recent",
  channels: "Channels",
  dates: "Dates",
  notes: "Notes",
  result: "Result",
} as const;

/** The kinds a logged touch can be. The vault stores the word. */
export const LOG_KINDS = ["Message", "Call", "Met up", "Note"] as const;

/** The cadence chips on the edit screen. THE HANDOFF'S `Never` IS ABSENT:
 *  `app.json` types `cadence_days` as an integer with a minimum of 1 for both
 *  `add-person` and `set-cadence`, so a "never" chip could only be written as
 *  a number that means something else. A chip that lies about what it wrote is
 *  worse than a chip that is not offered. */
export const CADENCE_CHIPS = [7, 14, 30, 90] as const;

/** Field labels on the edit, log and composer screens. */
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

/** The sub-line words the handoff names verbatim — `<kind> · <label> ·
 *  preferred`, `reminder on` / `reminder off` — and the row-meta fragments
 *  built from a number. */
export const FRAGMENTS = {
  preferred: "preferred",
  reminderOn: "reminder on",
  reminderOff: "reminder off",
  daysLeft: (days: number) =>
    days <= 0 ? "Today" : `${days} ${days === 1 ? "day" : "days"} left`,
  was: (field: string, value: string) => `${field} · was ${value}`,
} as const;

/** The merge screen's two person blocks. `Result` lives in `SECTIONS`. */
export const MERGE_HEADS = {
  keep: "Keep",
  mergeIn: "Merge in",
} as const;

/** Empty states. One sentence each, and each names its own shelf. */
export const EMPTY = {
  roster: "Nobody here yet.",
  noMatch: "Nothing matches.",
  searchIdle: "Type to search.",
  reconnect: "Nobody is overdue.",
  upcoming: "No dates coming up.",
  recent: "Nothing logged yet.",
  channels: "No channels.",
  dates: "No dates.",
  notes: "No notes.",
  trash: "Trash is empty.",
  merge: "Nobody to merge in.",
} as const;

/** The whole-app first run. The head is the display rung, the line is one
 *  sentence, and the single commit is the way forward. */
export const FIRST_RUN = {
  title: "Add the people you keep up with",
  body: "Add someone, set how often to reach out, and log a touch each time you do.",
  action: VERBS.addPerson,
} as const;

/** The one sentence each screen is allowed. */
export const SENTENCES = {
  mergeWarning: "Merging cannot be undone.",
  merged: "Merged.",
  trashPurge: "Erased after 30 days.",
} as const;

/** The three modal confirms. Revoke is absent — there is no link to revoke. */
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

/** The frame's status line, per screen. Contract-honest: these count people,
 *  overdue and starred, because those are the numbers the queries return. */
export const STATUS = {
  roster: (people: number, due: number, starred: number) =>
    `${people} people · ${due} to reconnect · ${starred} starred`,
  touch: (people: number, due: number) => `${people} people · ${due} overdue`,
  searchResting: "Searches names, roles and notes",
  searchResults: (matched: number, total: number) =>
    `${matched} of ${total} match`,
  searchUnreachable: "Search could not be reached.",
  logging: "Logging stamps last contacted",
  editing: "Nothing is written until you save",
  trash: (count: number) => `${count} in trash · ${SENTENCES.trashPurge}`,
} as const;

/** What a write says once it lands. Each is a fragment naming its object. */
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

/** What a write says when it did NOT land. A denial, a park and a queue are
 *  three different facts and each keeps its own sentence. */
export const REFUSALS = {
  denied: "The vault refused that write.",
  parked: "Waiting for approval.",
  queued: "Queued on this device.",
  failed: "That write did not land.",
  readFailed: "The vault is out of reach.",
} as const;

/** The denial banner's headline; the message beside it is the vault's own. */
export const CONSENT_TITLE = "No vault access yet.";

/** Accessible names for the controls that are a glyph on screen. */
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
