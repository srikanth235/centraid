// THE WORDS THE EIGHT SURFACES BEYOND THE LIST SAY (README-Locker §5, §6, §9;
// GAPS.md §3.3).
//
// `view-copy.ts` is the §6 verbatim table plus everything the list, the gates
// and the notices say. This file is its other half — the field labels, the
// section heads, and the field notes of the routes reached from the rail's
// *Acts* group and the band. The split is the 500-line file rule and nothing
// else: the two files are ONE table, and a sentence lives in whichever of them
// its route reads.
//
// A GAP TAG IS PART OF THE COPY. GAPS.md's own rule is that every tag appears
// on the surface, in the field note, so a reviewer reading the screen sees the
// scope without reading the register. `[backend-needed]`, `[open-question]`
// and `[exists]` are therefore literal strings here, and they are not
// decoration to be tidied away later.
//
// THE REGISTER IS §7's, the same as next door: item, reveal, conceal, permit,
// receipt, passphrase, alias, review, verdict, window. Never "master
// password", never "secure", never a reassurance adjective.

import type { SearchStateCopy } from "../_shared/search-scaffold.ts";
import type { UnrunnableRow } from "./review-model.ts";
import { COMPROMISED_WHY } from "./view-copy.ts";

// ---------------------------------------------------------------------------
// Add / edit
// ---------------------------------------------------------------------------

export const EDIT_HEAD_NEW = "New item";
export const EDIT_HEAD_EDIT = "Edit";
export const EDIT_SAVE = "Save";
export const EDIT_CANCEL = "Cancel";
export const EDIT_FOOT =
  "Saved to the vault directly · nothing about it is queued";
/** Offline the commit is WITHHELD, and this stands where it was — the rule
 *  again, at the moment it applies (STATES.md, Locker / Add-edit / offline). */
export const EDIT_FOOT_OFFLINE =
  "The gateway is out of reach · a secret write waits for it rather than queueing";
/** The lede's second sentence — what the rule does NOT cost. */
export const EDIT_LEDE_TAIL =
  "Everything else here — the star, the tags, the trash — works offline.";

export const TYPE_ROW = "Type";
export const TITLE_ROW = "Title";
export const TITLE_PLACEHOLDER = "What this is";

/** The prioritised expansion (GAPS §3.3 #1), in the order it unblocks most. */
export const NEXT_TYPES: readonly string[] = [
  "SSH key",
  "API credential",
  "Passport",
  "Bank account",
  "Driving licence",
  "Software licence",
  "Crypto wallet",
  "Membership",
  "Document",
];

export const TYPE_NOTE = `Six exist. A type is a set of sections and fields, so one the vault does not have yet degrades to a note with custom fields rather than to nothing. Next, in order: ${NEXT_TYPES.join(", ")}. [backend-needed]`;

export const TITLE_NOTE = "Metadata · searchable.";

/** Per-field notes, by the action key the field writes to. */
export const FIELD_NOTE: Readonly<Record<string, string>> = {
  username: "Metadata · searchable, and it never needed a permit.",
  password: "Type it, paste it, or generate it here without leaving the form.",
  url: "The match policy Companion obeys. Several addresses per login is [backend-needed].",
  otp_seed:
    "Paste an otpauth URI or the seed itself · a QR code is scanned on the phone, and that is [backend-needed]",
  content:
    "Sealed at rest, and deliberately not searched — a note routinely holds recovery codes.",
  notes: "Plaintext, yours, never a secret and never searched.",
  card_number: "Sealed like any other secret.",
  cvv: "Three digits, sealed like any other secret.",
  expiry: "Read by Review · 90 days out is a verdict.",
  network: "Metadata · the network name is not a secret.",
};

/** What a sealed field says when it is standing in for one nobody revealed. */
export const SEALED_UNCHANGED =
  "Left as it is · type here only to replace the stored secret";

export const MATCH_POLICY_ROW = "Match";
export const MATCH_DOMAIN = "Registrable domain";
export const MATCH_HOST = "Exact host";
export const MATCH_NOTE_DOMAIN = "Any host under the domain.";
export const MATCH_NOTE_HOST = "That host, and nowhere else.";

export const TAGS_ROW = "Tags";
export const TAGS_PLACEHOLDER = "work, money";
export const TAGS_NOTE =
  "Free-form, and the same vocabulary the rest of the superapp uses.";

export const ALIAS_ROW = "Alias";
export const ALIAS_NONE = "None";
export const ALIAS_NOTE =
  "A stable name an automation holds, so rotating the secret does not break it. The vault command takes one; this app's action does not forward it yet. [backend-needed · small]";

export const CONNECTION_ROW = "Guards";
export const CONNECTION_NONE = "No connection";
export const CONNECTION_NOTE =
  "The sync connection this credential belongs to, and the connector alias that follows it. [backend-needed]";

export const CUSTOM_ROW = "Custom fields";
export const CUSTOM_VALUE = "Not available yet";
export const CUSTOM_NOTE =
  "Text, concealed, address, date or a one-time code, grouped into sections. The largest structural gap: without it every unusual credential ends up in a note, and notes are deliberately unsearchable here. [backend-needed]";

export const EDIT_SAVED = "Saved · straight to the vault, nothing queued";
export const EDIT_CREATED = "Item created · straight to the vault";
export const EDIT_TITLE_MISSING = "A title first — the list is titles.";

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export const GEN_HEAD = "Generator";
export const GEN_KIND_ROW = "Kind";
export const GEN_LENGTH_ROW = "Length";
export const GEN_INCLUDE_ROW = "Include";
export const GEN_KINDS: readonly (readonly [string, string])[] = [
  ["chars", "Characters"],
  ["words", "Words"],
  ["pin", "PIN"],
];
export const GEN_DIGITS = "Digits";
export const GEN_SYMBOLS = "Symbols";
export const GEN_COPY = "Copy";
export const GEN_REGENERATE = "Regenerate";
export const GEN_PUT_ON_ITEM = "Put it on an item";
export const GEN_NOTE =
  "Look-alike characters are excluded always, so a password read off a screen and typed on a keypad is the same password.";
export const GEN_NOTHING_SAVED =
  "Nothing is written until you put it on an item.";
export const GEN_PIN_STRENGTH =
  "A PIN is short by definition · for a lock that only takes digits";
export const GEN_REGENERATED = "Regenerated · nothing was saved";
export const GEN_SEEDED =
  "On the form · nothing is written until the item is saved";

/** The strength sentence over a generated string, by the score's own word. */
export function genStrengthCopy(label: string, length: number): string {
  return `${label} · ${length} characters, and nothing in it is a word, a date or a look-alike`;
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export const REVIEW_ATTENTION = "Needs attention";
export const REVIEW_UNRUNNABLE = "Checked, and cannot be checked";
export const REVIEW_ITEMS = "The items";
export const REVIEW_UNRUNNABLE_META = "the honest half of a review surface";
export const REVIEW_ITEMS_META = "the same rows as the list, with the verdict";
export const REVIEW_SHOW_THEM = "Show them";
export const REVIEW_CHANGE_IT = "Change it";
export const REVIEW_NOTHING = "Nothing to review yet.";
export const REVIEW_NOTHING_BODY =
  "A verdict needs an item to be about, and there are none here.";
export const ALL_CLEAR = "All clear";
export const ALL_CLEAR_ACT = "What was checked";
/** The dash a check with no answer wears, instead of a zero it did not earn. */
export const NO_ANSWER = "—";

export const CHECK_LABEL: Readonly<Record<string, string>> = {
  compromised: "Compromised",
  weak: "Weak",
  reused: "Reused",
  http: "Unsecured address",
  expiring: "Expiring",
};

export const CHECK_WHY: Readonly<Record<string, string>> = {
  compromised: COMPROMISED_WHY,
  weak: "Scored against the same rule the item view shows, so the two can never disagree.",
  reused:
    "The same password on two or more live logins · trashed items are exempt.",
  http: "The saved address is http. Pure read — the data is already there. [exists]",
  expiring:
    "A card expiry inside 90 days. Document expiry follows once those types exist. [exists for cards]",
};

/** A check with a producer, a source, and no read that carries it to this
 *  screen. Named as its own fact — a zero here would be a claim nobody made. */
export const UNSERVED_WHY: Readonly<Record<string, string>> = {
  http: "The address is in the vault; the list read does not carry it, so nothing was checked. [backend-needed · small]",
  expiring:
    "The expiry is in the vault; the list read does not carry it, so nothing was checked. [backend-needed · small]",
};

/** The three checks with no source at all (GAPS §3.3 #6c, #6d, #6e). */
export const UNRUNNABLE_CHECKS: readonly UnrunnableRow[] = [
  {
    key: "2fa",
    label: "Two-factor available",
    why: "Would need a source for which sites support it. Nothing in the vault knows. [open-question]",
  },
  {
    key: "age",
    label: "Password age",
    why: "Needs item history, which Locker does not have yet. [backend-needed]",
  },
  {
    key: "breach",
    label: "Breach checking",
    why: COMPROMISED_WHY,
  },
];

/** The all-clear screen's account of itself: what ran, over how many, when. */
export function allClearBody(items: number, checks: number): string {
  return `${items} items read, ${checks} checks run · the checks this product cannot honestly run are listed below rather than left out`;
}

export function checkedAt(clock: string): string {
  return `checked at ${clock}`;
}

export function verdictMeta(verdicts: number, checks: number): string {
  return `${verdicts} verdicts across ${checks} checks`;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export const SEARCH_PLACEHOLDER = "Search titles, usernames and addresses";
export const SEARCH_SCOPE = "titles, usernames and addresses";
export const SEARCH_MATCHED = "matched the title, username or address";
export const SEARCH_RESULTS = "Results";

export const SEARCH_COPY: SearchStateCopy = {
  resting: {
    eyebrow: "Search",
    title: "Title, username, address",
    body: "A secret value is never searched, and neither is a note.",
  },
  searching: {
    lead: "Searching metadata.",
    trail: () => "so far",
  },
  miss: {
    eyebrow: "No match",
    title: (query: string) => `Nothing matches “${query}”.`,
    body: "Only titles, usernames and addresses were read.",
    clear: "Clear",
  },
  unreachable: {
    eyebrow: "Not searched",
    title: "The vault did not answer",
    body: "Nothing was checked, so nothing can be reported as missing.",
    facts: [{ label: "Scope", value: "titles, usernames and addresses" }],
    retry: "Try again",
  },
};

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export const IMPORT_HEAD = "Import";
export const IMPORT_LEDE =
  "Draft, review, publish · nothing reaches the vault until the draft is published, and the vault wins every collision";
export const IMPORT_FILE_ROW = "A file";
export const IMPORT_FILE_VALUE = "Not available yet";
export const IMPORT_FILE_NOTE =
  "The staging plane parses a password-manager CSV and holds it as a draft, but this app has no door to it: the shell's client offers reads, writes and blob staging, and no import. [backend-needed]";
export const IMPORT_REVIEW_ROW = "The review";
export const IMPORT_PUBLISH_ROW = "The publish";
export const IMPORT_PUBLISH_NOTE =
  "One act, over the whole draft, and it needs the gateway · a draft discarded writes nothing at all";
export const IMPORT_VERDICTS_ROW = "Verdicts";

// ---------------------------------------------------------------------------
// Access history
// ---------------------------------------------------------------------------

export const ACCESS_HEAD = "Access history";
export const ACCESS_LEDE =
  "Every authentication and every reveal, with the page origin where there was one";
export const ACCESS_REGISTER: readonly (readonly [string, string])[] = [
  ["Unlocked", "a session opened, and on which device"],
  ["Revealed", "one field of one item, and the permit that bought it"],
  ["Copied", "the same act as a reveal, and it costs the same permit"],
  ["Filled", "Companion, carrying the page origin it filled into"],
  ["Refused", "a wrong passphrase or a backed-off attempt · receipted too"],
];
export const ACCESS_NOT_SERVED =
  "The receipts are written and kept, and no query serves them to this screen yet. [backend-needed]";
export const ACCESS_WHERE =
  "Approvals shows the same receipts today, across every app.";

// ---------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------

export const TRASH_HEAD = "Trash";
export const TRASH_META = "star and tags kept, so a restore is lossless";
export const TRASH_EMPTY = "Nothing in the trash.";
export const TRASH_RESTORE = "Restore";
export const TRASH_PURGE = "Purge";
export const PURGE_CONFIRM_TITLE = "Purge it now?";
export const PURGE_CONFIRM_LABEL = "Purge";
export const PURGED = "Purged · gone for good";
export const PURGE_PARKED = "Parked · it waits for the owner’s confirmation";
export const RESTORED_WHOLE = "Restored · whole, with its star and its tags";

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const EXPORT_HEAD = "Export everything";
export const EXPORT_LEDE_TAIL = "There is no encrypted export today.";
export const EXPORT_WHAT_ROW = "What leaves";
export const EXPORT_FORMAT_ROW = "Format";
export const EXPORT_FORMAT_VALUE = "CSV, a 1Password dialect";
export const EXPORT_FORMAT_NOTE =
  "So the file lands somewhere else without a converter.";
export const EXPORT_WHERE_ROW = "Where";
export const EXPORT_WHERE_VALUE =
  "This device only · it is never sent anywhere";
export const EXPORT_WHERE_NOTE =
  "Written locally — what happens to it afterwards is outside the vault.";
export const EXPORT_COMMIT_ROW = "Write the file";
export const EXPORT_COMMIT_NOTE =
  "A sovereign vault must let you leave, and no command writes this file yet · nothing on this screen produces plaintext. [backend-needed]";
export function exportWhat(items: number): string {
  return `${items} items · every field, in the clear`;
}

// ---------------------------------------------------------------------------
// Companion
// ---------------------------------------------------------------------------

export const FILL_HEAD = "Companion";
export const FILL_LEDE =
  "Origin-matched candidates for the page in front of you · https only, and secret-free until the fill";
export const FILL_WHERE_ROW = "Where it runs";
export const FILL_WHERE =
  "In the browser extension, beside the page · never inside this app, which is why this screen offers no candidates";
export const FILL_GET_ROW = "How to get it";
export const FILL_GET =
  "Install the Companion extension on this browser; it asks this vault for candidates and nothing else.";
export const FILL_OFFERS_ROW = "What it offers";
export const FILL_OFFERS =
  "The logins whose address matches the page, one fill per gesture, and a receipt carrying that page origin.";
export const FILL_NOT_OFFERED = "Not offered";
export const FILL_NOT_OFFERED_META = "why a credential you have did not appear";

// ---------------------------------------------------------------------------
// The More sheet
// ---------------------------------------------------------------------------

/** The five surfaces behind the band's sixth slot, each with the one line
 *  that says what it is for. */
export const SURFACE_TITLE: Readonly<Record<string, string>> = {
  "built-in:import": "Import",
  "built-in:access": "Access history",
  "built-in:trash": "Trash",
  "built-in:export": "Export",
  "built-in:fill": "Companion",
};

export const SURFACE_META: Readonly<Record<string, string>> = {
  "built-in:import": "from a password manager",
  "built-in:access": "every reveal, receipted",
  "built-in:trash": "30 days, star and tags kept",
  "built-in:export": "plaintext, with the warning it deserves",
  "built-in:fill": "what the extension offers a page",
};

export const MORE_TITLE = "Locker";
export const MORE_FOOT = "Acts and surfaces · the four places are in the band";
export const MORE_CLOSE = "Close";
