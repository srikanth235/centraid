import type { LockerItemType } from "./types.ts";

export const ITEMS_STATUS =
  "Titles, usernames and addresses are browsable · a secret is revealed per item, per gesture, and receipted";

export const SEALED_NOTE =
  "Sealed at rest — revealing it mints a one-shot permit of 30 seconds and writes a receipt.";

export function revealedNote(elapsed: number, remaining: number): string {
  return `Revealed ${elapsed} seconds ago · it conceals itself in ${remaining}, and the receipt is already written.`;
}

export const PERMIT_GATE_ASK = "Your passphrase.";
export const PERMIT_GATE_LIFE =
  "This mints one permit for this field, good for about 30 seconds.";
export const PERMIT_GATE_RECEIPT =
  "It writes a receipt with the time and this device.";

export const OPEN_ITEM_LABEL = "This item";

export function permitGateTitle(fieldLabel: string): string {
  return fieldLabel === OPEN_ITEM_LABEL
    ? "Open this item?"
    : `Reveal the ${fieldLabel.toLowerCase()}?`;
}

export const LOCK_BODY =
  "Five minutes of inactivity, hidden windows and a restart all end a session.";

export const SETUP_BODY =
  "Twelve characters at least, the only way in that cannot be revoked, and nothing here is browsable until it exists.";

export const SEARCH_NOTE =
  "Secret values and notes are not searched — a note routinely holds recovery codes.";

export const WINDOW_RULE = "the window is 300 by default and 2,000 at most.";

export const TRASH_CONFIRM_BODY =
  "Thirty days, with its star and its tags, so a restore brings it back whole.";

export const PURGE_PARKED_BODY =
  "Irreversible, and asked for on a device that is not the owner’s, so it parks until the owner confirms it.";

export const IMPORT_VERDICT = {
  new: "new login",
  gapfill: "fills the empty fields only",
  held: "a vault secret already exists — the vault wins",
} as const;

export const IMPORT_VERDICT_CHIP = {
  new: "NEW",
  gapfill: "GAP FILL",
  held: "HELD",
} as const;

export const NOT_OFFERED = {
  policy: "its policy is exact host, and this page is not that host",
  http: "the page is http · Companion offers nothing over http",
  nomatch: "no address match · a near-miss is never a match",
} as const;

export const EXPORT_LEDE =
  "This writes every title, username, address, note and password to a plaintext file on this device. Anything that reads the file reads your secrets.";

export const COMPROMISED_WHY =
  "Flagged by hand or by an import; nothing sets it automatically, because breach checking would mean network egress.";

export const VIEWER_REFUSED =
  "A shared browser cannot hold the user-presence boundary this app depends on, so Locker refuses the seat outright.";

export const DAY_ONE_TITLE = "Nothing is kept here yet.";
export const DAY_ONE_BODY =
  "Bring a password manager’s file in, or put one login in by hand.";
export const DAY_ONE_IMPORT = "Import a file";
export const DAY_ONE_ADD = "Add a login";

export const NO_MATCH = "Nothing matches this filter.";

export const NEW_ITEM = "New item";
export const EDIT_ITEM = "Edit";
export const GENERATE = "Generate";
export const COPY_PASSWORD = "Copy password";

export const REVEAL = "Reveal";
export const CONCEAL = "Conceal";
export const COPY = "Copy";
export const SHOW_CODE = "Show the code";

export const PERMIT_CONFIRM = "Confirm";
export const PERMIT_CANCEL = "Cancel";

export const SHOW_MORE = "Show more";

export const UNLOCK = "Unlock";
export const CREATE_PASSPHRASE = "Create it";
export const SETUP_PLACEHOLDER = "At least 12 characters";
export const LOCK_PLACEHOLDER = "Passphrase";

export const PASSPHRASE_MINIMUM = 12;
export const PASSPHRASE_TOO_SHORT = "Twelve characters at least.";

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

export const DENIED_TITLE = "Locker cannot read this vault";
export const DENIED_BODY =
  "Every item, every receipt and every secret is untouched, and nothing was deleted.";
export const DENIED_SCOPE = "locker.read · locker.write";

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

export const STARRED = "Starred · receipted";
export const UNSTARRED = "Star removed · receipted";
export const TRASHED = "Moved to trash · receipted";
export const RESTORED = "Restored · receipted";

export const EDIT_LEDE =
  "Creating and editing a secret is online only, by design: no secret value ever enters the durable offline queue.";

export const TYPE_ORDER: readonly LockerItemType[] = [
  "login",
  "card",
  "note",
  "identity",
  "wifi",
  "password",
];

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

export const RAIL_HEADS = {
  vault: "The vault",
  types: "Types",
  acts: "Acts",
} as const;

export const RAIL_ALL = "All items";
export const RAIL_STARRED = "Starred";
export const RAIL_REVIEW = "Review";
export const RAIL_ARCHIVED = "Archived";

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

export const FIELD_LABEL: Readonly<Record<string, string>> = {
  item: OPEN_ITEM_LABEL,
  password: "Password",
  card_number: "Card number",
  cvv: "Security code",
  content: "Note",
  otp_seed: "One-time code",
};
