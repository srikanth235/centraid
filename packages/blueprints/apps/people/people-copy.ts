// EVERY STRING PEOPLE PUTS ON SCREEN. One module, so a component cannot mint
// copy and the whole inventory can be read in one sitting — the same shape
// `docs/view-copy.ts` gives Docs.
//
// THE VAULT LINK NOW HAS COPY, because the contract now answers it. The
// queries carry the sharing plane (`queries/_shared.ts`): who is linked
// (`linked`, `vault_count`), what is shared with them, and which invitations
// are still out. So the linked/unlinked chips, the vault-link sub-lines, the
// `Vaults` and `Shared with them` sections and the vault-counting status lines
// live here in full.
//
// TWO STRINGS FROM THE HANDOFF'S INVENTORY ARE STILL ABSENT, and each is an
// absence rather than an omission:
//
// - `Share` / `Link vault` (the person screen's commits) and the roster's
//   trailing `Link` verb. A share is always a share OF A CONTAINER —
//   `window.centraid.share` requires `containerType` + `containerId`
//   (`types/centraid.d.ts`), and the shared sheet refuses to send without them
//   (`_shared/ShareSheet.tsx`). People owns no container, and no People action
//   writes a party↔vault binding, so a `Link vault` here could only open a
//   sheet that cannot send. The reads are honest; the write is not there yet.
// - `Revoke`, on a vault row and on a shared item. Nothing in `app.json` grants
//   People a write on the sharing plane — its `share.*` scopes are `read` —
//   so a `Revoke` would be a control naming an act this app cannot perform.
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

/** The roster's filter chips. `Overdue` is the handoff's four plus one: the
 *  Touch screen's Reconnect tile navigates to it, and a tile that filtered to
 *  a chip nobody could see would be a filter with no way back off it. */
export const FILTER_CHIPS = [
  { id: "all", label: "All" },
  { id: "linked", label: "Linked" },
  { id: "unlinked", label: "Unlinked" },
  { id: "starred", label: "★" },
  { id: "due", label: "Overdue" },
] as const;

/** The two chips that are only honest while the sharing plane can be read. */
const LINK_CHIP_IDS: readonly string[] = ["linked", "unlinked"];

/**
 * The chips a screen may honestly draw. When the link facts are unavailable —
 * People's `share.*` scopes parked for the owner's approval, say — `Linked`
 * and `Unlinked` are absent rather than present and empty: a chip that
 * filtered every row away would read as "nobody is linked", which is a
 * different fact from "we cannot see".
 */
export function filterChips(
  linksAvailable: boolean
): readonly { id: string; label: string }[] {
  if (linksAvailable) return FILTER_CHIPS;
  return FILTER_CHIPS.filter((chip) => !LINK_CHIP_IDS.includes(chip.id));
}

/** The Touch screen's four count tiles while the link facts are unreadable.
 *  `Reconnect` and `Upcoming` take the consequence tone while they are above
 *  zero — they are the two that ask for something. */
export const TOUCH_TILES = [
  { id: "all", label: "People", net: false },
  { id: "reconnect", label: "Reconnect", net: true },
  { id: "upcoming", label: "Upcoming", net: true },
  { id: "starred", label: "Starred", net: false },
] as const;

/** The handoff's own four, drawn while the link counts are readable. `Vaults`
 *  counts LINKED PEOPLE, which is the same number: the sharing plane keeps at
 *  most one live binding per party (`queries/_shared.ts`). `Starred` gives up
 *  its tile to `To link` — the star already has a chip on the roster. */
export const LINK_TOUCH_TILES = [
  { id: "linked", label: "Vaults", net: false },
  { id: "to_link", label: "To link", net: true },
  { id: "reconnect", label: "Reconnect", net: true },
  { id: "upcoming", label: "Upcoming", net: false },
] as const;

/** Touch's three sections, and the person screen's five. */
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

/**
 * The vault link, in words. The rows say `Linked vault` rather than a vault's
 * name because a binding carries only a `vault_id` and an id is not a name —
 * printing one only ever looked like one (`_shared/share-kit.ts` refuses the
 * same fallback for the same reason).
 */
export const LINK = {
  /** Leads a linked person's second line: `Linked · architect`. */
  linked: "Linked",
  /** One live party↔vault binding, as a row. */
  vaultRow: "Linked vault",
  /** `linked 41 days ago` — the binding row's second line. */
  linkedWhen: (when: string) => `linked ${when.toLowerCase()}`,
  /** An invitation this person has not answered yet. */
  inviteRow: "Invitation sent",
  inviteWaiting: "waiting to be accepted",
  /** A shared container this person has not accepted yet. */
  waiting: "waiting",
  /** `read · since 4 March` — a shared row's second line. */
  sharedSince: (capability: string, when: string) =>
    `${capability} · since ${when.toLowerCase()}`,
  /** The two capabilities, in the handoff's own words. */
  read: "read",
  readWrite: "read + write",
} as const;

/**
 * How a shared container is named when the invitation carried no label. The
 * container TYPE is the only thing the grant itself knows, so it is worded
 * rather than printed as a schema name.
 */
export const CONTAINER_WORDS: Readonly<Record<string, string>> = {
  "core.collection": "An album",
  "core.content_item": "A note",
  "core.document": "A document",
  "docs.folder": "A folder",
  "media.asset": "A photograph",
  "tally.group": "A group",
};

/** What an unlabelled container of an unknown type is called. */
export const CONTAINER_FALLBACK = "Shared items";

/** The kinds a logged touch can be. The vault stores the word. */
export const LOG_KINDS = ["Message", "Call", "Met up", "Note"] as const;

/** The cadence chips on the edit screen. `Never` IS THE ZERO, and the contract
 *  now holds it: `people_profile.cadence_days` floors at 0 in the vault schema
 *  and both `add-person` and `set-cadence` type it with a minimum of 0, so the
 *  chip writes the number it names. A person on zero is never overdue
 *  (`format.ts` isOverdue), which is what "never" means here. */
export const CADENCE_CHIPS = [0, 7, 14, 30, 90] as const;

/** The zero chip's word. Every other chip is `agoLabel(days)`. */
export const CADENCE_NEVER = "Never";

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
  vaults: "Not linked yet.",
  shared: "Nothing shared yet.",
  sharedUnlinked: "Link a vault to share.",
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

/** The handoff's three modal confirms, minus Revoke: People reads the sharing
 *  plane and writes none of it (see the head of this file), so there is no
 *  revoke to confirm. */
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

/** The frame's status line, per screen. Two of them come in a pair: the
 *  handoff's own vault-counting sentence while the sharing plane can be read,
 *  and the people-counting one while it cannot — never a zero standing in for
 *  a number nobody could see. */
export const STATUS = {
  roster: (people: number, due: number, starred: number) =>
    `${people} people · ${due} to reconnect · ${starred} starred`,
  rosterLinked: (
    linked: number,
    people: number,
    toLink: number,
    due: number,
    starred: number
  ) =>
    `${linked} vaults across ${people} people · ${toLink} to link · ${due} to reconnect · ${starred} starred`,
  /** The roster's app-bar meta on a pointer surface. */
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
