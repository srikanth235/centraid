// EVERY WORD LOCKER SAYS, in one table (README-Locker §6, §7).
//
// The §6 rows are VERBATIM: this app's whole claim is that it states its own
// boundary in words rather than implying it with a lock icon, so the sentences
// are the interface and paraphrasing one is a defect, not a tidy-up.
//
// THE REGISTER (§7). Words: item, reveal, conceal, permit, receipt,
// passphrase, device credential, alias, review, verdict, window. Never:
// "vault" for a collection of items (there is one vault), "master password",
// "secure", "bank-grade", "protected", or any reassurance adjective. Nothing
// in this file may acquire one.

import type { LockerItemType } from "./types.ts";

// ---------------------------------------------------------------------------
// §6 · the verbatim table
// ---------------------------------------------------------------------------

/** The Items route's ambient status line. */
export const ITEMS_STATUS =
  "Titles, usernames and addresses are browsable · a secret is revealed per item, per gesture, and receipted";

/** The note under a sealed field. */
export const SEALED_NOTE =
  "Sealed at rest — revealing it mints a one-shot permit of 30 seconds and writes a receipt.";

/** The note under a revealed field — how long it has been open, how long is
 *  left, and that the cost has already been paid. */
export function revealedNote(elapsed: number, remaining: number): string {
  return `Revealed ${elapsed} seconds ago · it conceals itself in ${remaining}, and the receipt is already written.`;
}

/**
 * The permit gate's body, ONE LITERAL PER LINE THE GATE DRAWS. The gate names
 * the item, then what it asks for, then the permit's life, then the receipt —
 * four lines under the question, which is why the sentences are four strings
 * and not one paragraph glued back together (`components/PermitGate.tsx`).
 */
export const PERMIT_GATE_ASK = "Your passphrase.";
export const PERMIT_GATE_LIFE =
  "This mints one permit for this field, good for about 30 seconds.";
export const PERMIT_GATE_RECEIPT =
  "It writes a receipt with the time and this device.";

/** What the gate calls a permit that buys the read rather than one field. */
export const OPEN_ITEM_LABEL = "This item";

/**
 * The permit gate's question, over the field being asked for — or over the
 * ITEM, for a type that seals nothing and whose read is the thing the permit
 * authorises. Two questions because they are two acts, and a gate that asked
 * to "reveal the item" would be naming something no field is called.
 */
export function permitGateTitle(fieldLabel: string): string {
  return fieldLabel === OPEN_ITEM_LABEL
    ? "Open this item?"
    : `Reveal the ${fieldLabel.toLowerCase()}?`;
}

/** The lock screen's sentence about what a session is. */
export const LOCK_BODY =
  "Five minutes of inactivity, hidden windows and a restart all end a session.";

/** The first-run gate's sentence. */
export const SETUP_BODY =
  "Twelve characters at least, the only way in that cannot be revoked, and nothing here is browsable until it exists.";

/** What Search does not search, and why it is a design rather than an omission. */
export const SEARCH_NOTE =
  "Secret values and notes are not searched — a note routinely holds recovery codes.";

/** The bounded window's second clause. The count in front of it is derived —
 *  see `format.ts` `windowEndCopy` and the note there about the missing total. */
export const WINDOW_RULE = "the window is 300 by default and 2,000 at most.";

/** The trash confirm. */
export const TRASH_CONFIRM_BODY =
  "Thirty days, with its star and its tags, so a restore brings it back whole.";

/** A purge asked for on a device that is not the owner's. */
export const PURGE_PARKED_BODY =
  "Irreversible, and asked for on a device that is not the owner’s, so it parks until the owner confirms it.";

/**
 * THE THREE VERDICTS AN IMPORT ROW WEARS. Lower case because each is the
 * PREDICATE of the row it sits on ("Netflix · new login"), and because the
 * middle one is a promise about what an import will not touch: a row that
 * fills the empty fields only never overwrites a secret the vault holds.
 */
export const IMPORT_VERDICT = {
  new: "new login",
  gapfill: "fills the empty fields only",
  held: "a vault secret already exists — the vault wins",
} as const;

/** The chip over each of those, in the register's own words. */
export const IMPORT_VERDICT_CHIP = {
  new: "NEW",
  gapfill: "GAP FILL",
  held: "HELD",
} as const;

/** Why a credential a member HAS was not offered on a page. Three different
 *  refusals, and Companion names which one rather than offering nothing and
 *  letting a member conclude the vault forgot the login. */
export const NOT_OFFERED = {
  policy: "its policy is exact host, and this page is not that host",
  http: "the page is http · Companion offers nothing over http",
  nomatch: "no address match · a near-miss is never a match",
} as const;

/** The export lede — the one place `--net` carries a whole paragraph. */
export const EXPORT_LEDE =
  "This writes every title, username, address, note and password to a plaintext file on this device. Anything that reads the file reads your secrets.";

/** The compromised verdict, and the reason nothing produces it automatically. */
export const COMPROMISED_WHY =
  "Flagged by hand or by an import; nothing sets it automatically, because breach checking would mean network egress.";

/** The viewer seat's refusal. Locker never renders this itself — the shell
 *  walls the seat before this app's Root mounts (packages/client's
 *  `InlineAppRoute` + `inlineAppSeats.ts`) — but the sentence is the app's,
 *  and it lives here so the shell's copy has one place to be reconciled with. */
export const VIEWER_REFUSED =
  "A shared browser cannot hold the user-presence boundary this app depends on, so Locker refuses the seat outright.";

// ---------------------------------------------------------------------------
// The routes' own words
// ---------------------------------------------------------------------------

/** The Items day-one block — one sentence, a second that says why the first
 *  item matters, and two ways in (README-Locker §4, STATES.md Locker/Items). */
export const DAY_ONE_TITLE = "Nothing is kept here yet.";
export const DAY_ONE_BODY =
  "Bring a password manager’s file in, or put one login in by hand.";
export const DAY_ONE_IMPORT = "Import a file";
export const DAY_ONE_ADD = "Add a login";

/** The empty a FILTER produces — a shelf is empty on its own terms. */
export const NO_MATCH = "Nothing matches this filter.";

/** The app bar's verbs. */
export const NEW_ITEM = "New item";
export const EDIT_ITEM = "Edit";
export const GENERATE = "Generate";
export const COPY_PASSWORD = "Copy password";

/** The field row's verbs. */
export const REVEAL = "Reveal";
export const CONCEAL = "Conceal";
export const COPY = "Copy";
export const SHOW_CODE = "Show the code";

/** The permit gate's own controls. */
export const PERMIT_CONFIRM = "Confirm";
export const PERMIT_CANCEL = "Cancel";

/** The window's foot. */
export const SHOW_MORE = "Show more";

/** The lock screen's controls. */
export const UNLOCK = "Unlock";
export const CREATE_PASSPHRASE = "Create it";
export const SETUP_PLACEHOLDER = "At least 12 characters";
export const LOCK_PLACEHOLDER = "Passphrase";

/** The setup gate's own rule, enforced before the write leaves the field. */
export const PASSPHRASE_MINIMUM = 12;
export const PASSPHRASE_TOO_SHORT = "Twelve characters at least.";

/** The lock screen's facts table (README-Locker §2, drawn as the design does). */
export const LOCK_FACTS: readonly (readonly [string, string])[] = [
  ["Session", "5 minutes, sliding · memory only"],
  ["On hiding", "locks at once · revealed values wiped, clipboard cleared"],
  ["Per item", "a fresh confirmation, one shot, about 30 seconds"],
  [
    "Failures",
    "rate limited, backing off · the receipt records the refusal too",
  ],
  ["Recovery", "the vault’s, not Locker’s · it lives in Settings"],
];

/** The denied gate — a revoked grant is a receipt, a scope, and the fact that
 *  nothing was deleted (README-Locker §4, "Denied vs. refused"). */
export const DENIED_TITLE = "Locker cannot read this vault";
export const DENIED_BODY =
  "Every item, every receipt and every secret is untouched, and nothing was deleted.";
export const DENIED_SCOPE = "locker.read · locker.write";

/** The notices, one per honest state (STATES.md Locker row). */
export function pendingNotice(count: number): string {
  return count === 1
    ? "1 metadata write is on this device · no secret is ever queued."
    : `${count} metadata writes are on this device · no secret is ever queued.`;
}
export const OFFLINE_NOTICE =
  "Offline · stars, tags, trash and restore work. Creating or editing a secret needs the gateway.";
export const OFFLINE_WHY = "Why";
export const OFFLINE_WHY_BODY =
  "A secret never enters the durable offline queue · that is the rule, not a limitation";
export function staleNotice(at: string): string {
  return `This replica last matched the vault at ${at}.`;
}
export const REFRESH = "Refresh";
export const CONFLICT_NOTICE =
  "This item was edited here and on another device.";
export const COMPARE = "Compare";
export const CONFLICT_COMPARE_BODY =
  "Two versions · keep one; the secret values are compared without being shown";
export const PARKED_NOTICE =
  "A purge was asked for on a device that is not the owner’s · it waits for you.";
export const REVIEW_IN_TRASH = "Review";
export const REAUTH_NOTICE =
  "The permit for this item expired · nothing is revealed.";

/** Write outcomes, for the one status line. */
export const STARRED = "Starred · receipted";
export const UNSTARRED = "Star removed · receipted";
export const TRASHED = "Moved to trash · receipted";
export const RESTORED = "Restored · receipted";

/** The lede every add / edit screen opens with, so the online-only rule is
 *  never discovered at commit (STATES.md, Locker / Add-edit / offline). */
export const EDIT_LEDE =
  "Creating and editing a secret is online only, by design: no secret value ever enters the durable offline queue.";

// ---------------------------------------------------------------------------
// Type vocabulary
// ---------------------------------------------------------------------------

/**
 * THE RAIL'S SIX ROWS — the column-backed types, in the order it lists them.
 *
 * THE RULING (#872 U2): the rail STAYS SIX. README-Locker §1 says "six rows
 * with counts", and nine more would turn a glanceable list into a taxonomy on
 * the one screen whose whole job is being scannable. The other nine types are
 * first-class everywhere else — the add form's chip row offers all fifteen,
 * search reaches them, and a `type:` filter names any of them — so nothing is
 * unreachable; it is only not a permanent row in a column of six.
 */
export const TYPE_ORDER: readonly LockerItemType[] = [
  "login",
  "card",
  "note",
  "identity",
  "wifi",
  "password",
];

/**
 * ALL FIFTEEN, in the order the add form offers them: the six that own columns
 * on `locker_item`, then the nine (#872, GAPS §3.3 #1) whose fields the vault
 * mints from a template — listed in the order the gap register prioritised,
 * which is the order they unblock the most.
 */
export const ALL_TYPES: readonly LockerItemType[] = [
  "login",
  "card",
  "note",
  "identity",
  "wifi",
  "password",
  "ssh_key",
  "api_credential",
  "passport",
  "bank_account",
  "driving_licence",
  "software_licence",
  "crypto_wallet",
  "membership",
  "document",
];

export const TYPE_LABEL: Readonly<Record<LockerItemType, string>> = {
  login: "Login",
  card: "Card",
  note: "Secure note",
  identity: "Identity",
  wifi: "Wi-Fi",
  password: "Password",
  ssh_key: "SSH key",
  api_credential: "API credential",
  passport: "Passport",
  bank_account: "Bank account",
  driving_licence: "Driving licence",
  software_licence: "Software licence",
  crypto_wallet: "Crypto wallet",
  membership: "Membership",
  document: "Document",
};

/** The rail's plural, for a row that carries a count. */
export const TYPE_PLURAL: Readonly<Record<LockerItemType, string>> = {
  login: "Logins",
  card: "Cards",
  note: "Notes",
  identity: "Identities",
  wifi: "Wi-Fi",
  password: "Passwords",
  ssh_key: "SSH keys",
  api_credential: "API credentials",
  passport: "Passports",
  bank_account: "Bank accounts",
  driving_licence: "Driving licences",
  software_licence: "Software licences",
  crypto_wallet: "Crypto wallets",
  membership: "Memberships",
  document: "Documents",
};

/** The rail's three group heads (README-Locker §1). */
export const RAIL_HEADS = {
  vault: "The vault",
  types: "Types",
  acts: "Acts",
} as const;

/** The rail's own rows, above the types. */
export const RAIL_ALL = "All items";
export const RAIL_STARRED = "Starred";
export const RAIL_REVIEW = "Review";
/** Kept forever, out of the default window — and NEVER the trash row: one has
 *  a purge date and the other exists so nothing ever gets one. */
export const RAIL_ARCHIVED = "Archived";

/** The one word each route's app bar carries. */
export const ROUTE_TITLE = {
  items: "Locker",
  item: "Item",
  edit: "Add / edit",
  gen: "Generator",
  watch: "Review",
  search: "Search",
  import: "Import",
  access: "Access history",
  trash: "Trash",
  export: "Export",
  fill: "Companion",
  lock: "Locker",
  setup: "Locker",
} as const;

/** Each route's ambient status sentence — the one line, never a second. */
export const ROUTE_STATUS: Readonly<Record<string, string>> = {
  items: ITEMS_STATUS,
  item: "Nothing on this screen is revealed until you ask · asking writes a receipt",
  edit: "Creating a secret is online only · no secret enters the offline queue",
  gen: "Nothing here is saved until you put it on an item",
  watch:
    "Weak, reused and compromised · plus the checks this product cannot honestly run",
  search:
    "Secret values and notes are never searched · notes routinely hold recovery codes",
  import:
    "Draft, review, publish · an import never overwrites a secret the vault already holds",
  access:
    "Every reveal and every fill, with the page origin where there was one",
  trash: "Restores are lossless · purge is irreversible and confirmed",
  export: "Plaintext · the warning is the design",
  fill: "Origin-matched, https only, secret-free until the fill",
  lock: "The app boots locked and locks when hidden · the session is five minutes, in memory only",
  setup: "Nothing is browsable until there is a passphrase",
};

/**
 * The word a permit gate uses for the field it is being asked about. One table,
 * so the gate's question, the sealed row's key column and the copy outcome all
 * name the same field the same way — a gate that said "Reveal the content?"
 * over a row labelled "Note" would be asking about something else.
 */
export const FIELD_LABEL: Readonly<Record<string, string>> = {
  item: OPEN_ITEM_LABEL,
  password: "Password",
  card_number: "Card number",
  cvv: "Security code",
  content: "Note",
  otp_seed: "One-time code",
};
