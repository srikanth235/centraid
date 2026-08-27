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
// THE GAP TAGS ARE GONE, AND THAT IS THE NEWS (#872 U2). GAPS.md's rule was
// that every engineering-ask tag appears on the surface itself, in the field
// note, so a reviewer reading the screen sees the scope without reading the
// register. The engineering those tags named has landed: custom fields, item and
// password history, item-type breadth, several addresses, passkeys,
// attachments, export, archive, duplicate, the alias read-back, the honest
// window total and the access history all have doors now. So the notes below
// state what each row DOES rather than what it is waiting for.
//
// What is still stated as a limit is stated as a LIMIT, never as a promise
// deferred: breach checking and recently-used are rulings (GAPS §3.3 #6e,
// #11), and the QR scan is the phone's control rather than this seat's.
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

/**
 * THE TYPE NOTE. Fifteen types exist; SIX of them own columns on `locker_item`
 * and the other nine are sets of fields the vault mints from a template — which
 * is the same mechanism that lets a type this build does not know still open.
 *
 * The rail stays SIX ROWS with counts (README-Locker §1). The other nine are
 * reachable from this chip row and from the filters, because a rail listing
 * fifteen would be a taxonomy where a glanceable list belongs.
 */
export const TYPE_NOTE =
  "Fifteen exist · one the vault does not have yet degrades to a note with custom fields rather than to nothing.";

export const TITLE_NOTE = "Metadata · searchable.";

/** Per-field notes, by the action key the field writes to. */
export const FIELD_NOTE: Readonly<Record<string, string>> = {
  username: "Metadata · searchable, and it never needed a permit.",
  password: "Type it, paste it, or generate it here without leaving the form.",
  url: "The primary address, and the match policy Companion obeys. Further addresses are managed in their own row below.",
  otp_seed:
    "Paste an otpauth URI or the seed itself · a QR code is scanned on the phone, where the camera is",
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
  "A stable name an automation holds, so rotating the secret does not break it. Empty the field to clear it; type another to reassign it.";
export const ALIAS_PLACEHOLDER = "deploy-key";

export const CUSTOM_ROW = "Custom fields";
export const CUSTOM_NOTE =
  "Text, sealed, address, date or a one-time code, grouped into sections · one field per act.";
export const CUSTOM_NONE = "No custom fields.";
export const CUSTOM_ADD = "Add a field";
export const CUSTOM_REMOVE = "Remove";
export const CUSTOM_SAVE = "Save the field";
export const CUSTOM_SECTION_ROW = "Section";
export const CUSTOM_SECTION_PLACEHOLDER = "Recovery";
export const CUSTOM_LABEL_ROW = "Label";
export const CUSTOM_LABEL_PLACEHOLDER = "Recovery code";
export const CUSTOM_KIND_ROW = "Kind";
export const CUSTOM_VALUE_ROW = "Value";
export const FIELD_SAVED = "Field saved · straight to the vault";
export const FIELD_REMOVED = "Field removed · receipted";
export const CUSTOM_LABEL_MISSING =
  "A label first — a field with none is a value nobody can find again.";

export const ADDRESSES_ROW = "Addresses";
export const ADDRESSES_NOTE =
  "Every address this login answers to, each with its own match policy · the primary stays first.";
export const ADDRESSES_NONE = "No further addresses.";
export const ADDRESSES_ADD = "Add an address";
export const ADDRESSES_SAVE = "Save the addresses";
export const ADDRESSES_REMOVE = "Remove";
export const ADDRESSES_PLACEHOLDER = "https://example.test";
export const ADDRESSES_SAVED = "Addresses saved · receipted";
export const ADDRESSES_REPLACE_NOTE =
  "Saving replaces the whole list, so a row removed here is removed in the vault.";

export const PASSKEY_ROW = "Passkey";
export const PASSKEY_NONE = "No passkey.";
export const PASSKEY_NOTE =
  "Storage only · nothing here performs a WebAuthn ceremony. The key material is sealed like any other secret.";
export const PASSKEY_RP = "Relying party";
export const PASSKEY_HANDLE = "User handle";
export const PASSKEY_DISPLAY = "Display name";
export const PASSKEY_CREDENTIAL = "Credential id";
export const PASSKEY_ALGORITHM = "Algorithm";
export const PASSKEY_KEY = "Key material";
export const PASSKEY_KEY_PRESENT = "Present";
export const PASSKEY_KEY_ABSENT = "None stored";
export const PASSKEY_SAVE = "Save the passkey";
export const PASSKEY_CLEAR = "Clear the passkey";
export const PASSKEY_SAVED = "Passkey saved · straight to the vault";
export const PASSKEY_CLEARED = "Passkey cleared · metadata and key together";
export const PASSKEY_RP_MISSING =
  "A relying party first — a passkey belongs to a site.";

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
  age: "Password age",
};

export const CHECK_WHY: Readonly<Record<string, string>> = {
  compromised: COMPROMISED_WHY,
  weak: "Scored against the same rule the item view shows, so the two can never disagree.",
  reused:
    "The same password on two or more live logins · trashed items are exempt.",
  http: "The saved address is http, and the list read carries it.",
  expiring: "A card expiry inside 90 days, read off the row itself.",
  age: "The current password has stood over a year, counted from the day it was set.",
};

/**
 * A check with a producer, a source, and no read that carries it to this
 * screen. Named as its own fact — a zero here would be a claim nobody made.
 *
 * All three are SERVED today (`servedFields` reads the rows, not a flag), so
 * these sentences stand only if a read stops carrying a field. They are kept
 * for exactly that: a check that quietly went silent must still say so.
 */
export const UNSERVED_WHY: Readonly<Record<string, string>> = {
  http: "The address is in the vault; this read did not carry it, so nothing was checked.",
  expiring:
    "The expiry is in the vault; this read did not carry it, so nothing was checked.",
  age: "The date the password was set is in the vault; this read did not carry it, so nothing was checked.",
};

/** The three checks with no source at all (GAPS §3.3 #6c, #6d, #6e). */
export const UNRUNNABLE_CHECKS: readonly UnrunnableRow[] = [
  {
    key: "2fa",
    label: "Two-factor available",
    why: "Would need a source for which sites support it, and nothing in the vault knows.",
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
export const IMPORT_FILE_NOTE =
  "A password-manager CSV, parsed into a draft · nothing reaches the vault until the draft is published.";
export const IMPORT_CHOOSE = "Choose a file";
export const IMPORT_STAGED = "Staged as a draft · nothing is in the vault yet";
export const IMPORT_REVIEW_ROW = "The review";
export const IMPORT_PUBLISH_ROW = "The publish";
export const IMPORT_PUBLISH_NOTE =
  "One act, over the whole draft, and it needs the gateway · a draft discarded writes nothing at all";
export const IMPORT_VERDICTS_ROW = "Verdicts";
export const IMPORT_PUBLISH = "Publish the draft";
export const IMPORT_DISCARD = "Discard the draft";
export const IMPORT_DISCARDED = "Draft discarded · nothing was written";
export const IMPORT_DRAFTS = "Drafts";
export const IMPORT_DRAFTS_META = "staged, and not in the vault";
export const IMPORT_NO_DRAFTS = "No draft is waiting.";
export const IMPORT_ROWS = "The rows";
export const IMPORT_ROWS_META = "each with the verdict the vault gave it";
export const IMPORT_REVIEW_OPEN = "Review";
export const IMPORT_OTHER_ENTITY =
  "not a Locker item · it lands in the app that owns it";
/** Custodian-only, and it says which seat rather than which device (SURFACES.md
 *  — Import is a custodian surface). */
export const IMPORT_NO_DOOR =
  "Import runs on the custodian — the desktop beside the gateway — and the draft is reviewed and published there.";
/** The doors refuse offline BY CONSTRUCTION: an import payload is the raw file,
 *  secrets included, and a durable offline queue is where it must not sit. */
export const IMPORT_OFFLINE =
  "The gateway is out of reach · an import carries the file itself, secrets and all, so it waits for a connection rather than queueing";

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
export const ACCESS_ENTRIES = "The receipts";
export const ACCESS_ENTRIES_META =
  "newest first, and a refusal is listed like an allowance";
export const ACCESS_EMPTY = "No receipt has been written yet.";
export const ACCESS_EMPTY_BODY =
  "An unlock, a reveal or a fill writes one · nothing here is a record of what you looked at until you look at something.";
export const ACCESS_ALL_ITEMS = "Every item";
export const ACCESS_NARROW = "Only this item";
export const ACCESS_OFFLINE =
  "The gateway is out of reach · receipts live in the journal, which this device does not carry, and a cached history would be a list of what this device happened to hold";
export const ACCESS_NO_VALUES =
  "A receipt has never carried a value · these rows name the act, the item and the columns, and nothing else.";
export const ACCESS_WHERE =
  "Approvals shows the same receipts, across every app.";

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
  "A sovereign vault must let you leave · the confirm names the consequence, and the file is written on this device.";
export const EXPORT_COMMIT = "Write the file";
export const EXPORT_CONFIRM_TITLE = "Write every secret to a file?";
export const EXPORT_CONFIRM_LABEL = "Write it";
export const EXPORT_OPTIONS_ROW = "Also include";
export const EXPORT_TRASHED = "Trashed items";
export const EXPORT_HISTORY = "Previous passwords";
export const EXPORT_OPTIONS_NOTE =
  "Both are off unless you ask · every previous password is another secret in the file.";
export const EXPORT_WRITTEN = "Written · every secret is in that file now";
export const EXPORT_PARKED =
  "Parked · a mass reveal asked for on a device that is not the owner\u2019s waits for them";
export const EXPORT_OFFLINE =
  "The gateway is out of reach · an export is a mass reveal, and it is never answered from a device\u2019s durable store";
export const EXPORT_NOTHING = "Nothing came back · no file was written.";
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
