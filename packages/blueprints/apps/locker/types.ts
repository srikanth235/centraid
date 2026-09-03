// Shared page-side shapes for Locker. Type-only — no runtime members — so
// every importer uses `import type`, which the bundler strips. Grounded in the
// query payloads the backend already returns: `LockerRow` is the SECRET-FREE
// decorated row the `items` / `search` / `trash` queries hand back, and
// `LockerDetail` is the full, secret-bearing shape the single-item `item`
// query returns — the only payload in this app with secrets in it.
//
// THE ASYMMETRY IS IN THE TYPES, not only in the prose: a list is `LockerRow`,
// and there is no path by which a `LockerDetail` becomes one.

/**
 * The item-type discriminants Locker's schema recognizes (issue #712
 * C4) — the source of truth is the CHECK constraint on `locker_item.type`
 * (`packages/vault/src/schema/domains-locker.ts`). Kept in lockstep with it
 * by a source-scan tripwire (`locker-item-type.test.ts`), the same technique
 * `placement-registry.test.ts` uses for vault's `SHAREABLE_ITEM_TYPES`: this
 * file stays type-only (see above), so the union is restated here rather
 * than derived from a runtime array vault could export.
 *
 * The first six are COLUMN-backed on `locker_item`. The nine that follow
 * (#872) own no columns at all: a type is a set of sections and fields, minted
 * into `locker_item_field` from a template, which is what lets a type this
 * build does not know degrade to a note that still carries its fields.
 */
export type LockerItemType =
  | "login"
  | "card"
  | "note"
  | "identity"
  | "wifi"
  | "password"
  | "ssh_key"
  | "api_credential"
  | "passport"
  | "bank_account"
  | "driving_licence"
  | "software_licence"
  | "crypto_wallet"
  | "membership"
  | "document";

/** One owner-defined (or type-template) field on an item (#872). A `sealed`
 *  kind carries no value until it is revealed — `sealed: true` says the row
 *  HAS a secret without shipping it. */
export interface LockerCustomField {
  field_id: string;
  section: string;
  label: string;
  kind: "text" | "sealed" | "url" | "date" | "otp";
  value: string | null;
  /** True when the field's kind is sealed and a value is stored. */
  sealed?: boolean;
}

/** An additional address a login answers to, with its own match policy. */
export interface LockerAddress {
  address_id: string;
  url: string;
  match_policy: UrlMatchPolicy;
}

/** The passkey slot's METADATA. Key material is sealed and never in a read. */
export interface LockerPasskey {
  rp_id: string;
  user_handle?: string | null;
  display_name?: string | null;
  credential_id?: string | null;
  algorithm?: string | null;
  created_at?: string;
  /** True when key material is stored beside the metadata. */
  has_private_key?: boolean;
}

/**
 * One durable revision of an item (#872, ported to `core.entity_revision` in
 * #916 D2). It NAMES A CHANGE AND ITS TIME AND NOTHING ELSE: the snapshot the
 * vault kept is opened in the query layer, its sealed cells are never compared
 * and never forwarded, and there is no address here a reveal permit could be
 * minted for. A password this item was rotated away from survives sealed in
 * that snapshot and leaves the vault only through a confirmed `locker.export`.
 */
export interface LockerRevision {
  revision_id: string;
  operation: string;
  /** Column NAMES that the state superseding this snapshot says differently. */
  changed?: Record<string, unknown>;
  recorded_at: string;
}

/** One row of Locker's access history: an auth, a reveal, or a fill. */
export interface LockerAccessEntry {
  receipt_id: string;
  kind: "auth" | "reveal" | "fill";
  action: string;
  decision: "allow" | "deny";
  item_id: string | null;
  occurred_at: string;
  /** The page a Companion fill happened on. Absent for every other kind. */
  origin?: string | null;
  /** Which sealed columns a reveal opened — names, never values. */
  columns?: string[];
  /** Why a refusal was refused. A refusal is receipted too (§2). */
  reason?: string;
}

/** How a login's saved address is matched against a page (README §3). */
export type UrlMatchPolicy = "registrable-domain" | "exact-host";

/**
 * The five Review checks that have a producer today (README-Locker §5;
 * GAPS §3.3 #6a, #6b). The first three come from the vault's watchtower
 * aggregate, folded into the items read; the last two are pure reads of
 * metadata. The checks with NO producer are not in this union, on purpose —
 * they are copy on a screen, never a verdict a row can carry.
 */
export type CheckKey =
  | "compromised"
  | "weak"
  | "reused"
  | "http"
  | "expiring"
  /** How long the CURRENT password has stood. Runnable since the items read
   *  carries `password_set_at` (#872) — the check GAPS §3.3 #6d wanted item
   *  history for, answered by the item's own clock rather than its revisions. */
  | "age";

/** Secret-free decorated list row (items / search / trash queries). */
export interface LockerRow {
  item_id: string;
  type: LockerItemType;
  title: string;
  /** The query's own safe subtitle — a username, a card's last four, a kind. */
  subtitle?: string;
  favorite?: boolean;
  tags?: string[];
  weak?: boolean;
  reused?: boolean;
  compromised?: boolean;
  severity?: string;
  updated_at?: string;
  purge_at?: string | null;
  /**
   * The saved address, and a card's expiry. Both are METADATA — neither is a
   * sealed column — and both are what Review's *Unsecured address* and
   * *Expiring* checks read (GAPS §3.3 #6a, #6b, tagged `exists`). The items
   * query does not decorate rows with them TODAY, which is why they are
   * optional and why `review-model.servedFields` reports "not asked" rather
   * than a zero: a check that could not read its source has no verdict to
   * give, and reporting one would be the review overstating itself.
   */
  url?: string | null;
  expiry?: string | null;
  /** The connector alias bound to this item, read back since #872. */
  alias?: string | null;
  /** Kept forever, out of the default window. NEVER a purge date — an archived
   *  item and a trashed one are opposite ends of the same axis. */
  archived?: boolean;
  /** When the CURRENT password was set. Review's *Password age* reads it. */
  password_set_at?: string | null;
}

/** Full, secret-bearing item — the single-item `item` query, and nothing else.
 *  A value of this type lives ONLY in the orchestrator's ref bag, and only
 *  while a permit's reveal is on screen (session.ts `SECRET_BEARING_KEYS`). */
export interface LockerDetail {
  item_id: string;
  /** The type as this build can DRAW it. A type the vault has and this build
   *  does not degrades to `note`, and `degraded_from` names what it really is
   *  — a note that still carries its fields, never an empty pane. */
  type: LockerItemType;
  /** The stored discriminant, when it differs from `type`. Null otherwise. */
  degraded_from?: string | null;
  title: string;
  username?: string | null;
  password?: string | null;
  url?: string | null;
  url_match_policy?: UrlMatchPolicy | null;
  otp_seed?: string | null;
  notes?: string | null;
  cardholder?: string | null;
  card_number?: string | null;
  expiry?: string | null;
  cvv?: string | null;
  brand?: string | null;
  content?: string | null;
  fullname?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  network?: string | null;
  compromised?: boolean;
  favorite?: boolean;
  tags?: string[];
  trashed?: boolean;
  /** Connector alias (issue #298 item 4). Read back since #872 registered
   *  `locker_item_alias`, so the form can show it, clear it and reassign it —
   *  the first paper cut README-Locker §8 names. */
  alias?: string | null;
  /** Archived: kept forever, out of the default window, never purged. */
  archived?: boolean;
  archived_at?: string | null;
  /** When the CURRENT password was set — what Review reads for its age. */
  password_set_at?: string | null;
  /** Owner-defined sections and fields, plus the type's own template rows. */
  fields?: LockerCustomField[];
  /** ADDITIONAL addresses; `url` above stays the primary one. */
  addresses?: LockerAddress[];
  passkey?: LockerPasskey | null;
  /** Newest first. What changed and when — never what it changed from. */
  history?: LockerRevision[];
  /** Attachment METADATA — the bytes ride the content spine, unsealed. */
  attachments?: {
    attachment_id: string;
    content_id: string;
    role: string;
    title?: string | null;
    media_type?: string | null;
    byte_size?: number | null;
  }[];
  purge_at?: string | null;
  updated_at?: string;
}

/**
 * The `auth` query's answer (app.json → queries.auth). It lives here rather
 * than beside either consumer because BOTH legs of the boundary read it —
 * `session.ts` for unlock and lock, `permits.ts` for `authorize-item` — and a
 * shape declared in one of them would have made the other import it and close
 * a cycle around the very thing the two files exist to keep apart.
 *
 * Note what is NOT here: the passphrase. It is an argument to the query and
 * never a field of anything this app holds.
 */
export interface AuthPayload {
  ok?: boolean;
  configured?: boolean;
  authenticated?: boolean;
  sessionToken?: string;
  itemToken?: string;
  /** The id the vault minted for a device credential (`enroll-device`). It is
   *  an IDENTIFIER, never the secret: the random material stays on the device
   *  and only a vault-key-peppered verifier reaches the gateway. */
  credentialId?: string;
  expiresAt?: string;
  retryAfterMs?: number;
  code?: string;
  message?: string;
}

/** The `items` query's payload, as the orchestrator reads it. */
export interface ItemsPayload {
  items?: LockerRow[];
  truncated?: boolean;
  window?: number;
  /** How many live items EXIST, counted inside the vault — the other half of
   *  "300 of 312". Absent when the count could not be read; the foot line then
   *  says nothing rather than guessing. */
  total?: number;
  /** Live counts per type, for the rail's type rows. */
  byType?: { type: string; n: number }[];
  /** Archived and trashed counts, for the More rows. */
  archivedCount?: number;
  trashedCount?: number;
  watchtower?: {
    compromised?: number;
    weak?: number;
    reused?: number;
    items?: LockerRow[];
  };
  authRequired?: boolean;
  configured?: boolean;
  vaultDenied?: { code?: string; message?: string } | null;
}

/** The review's counts and the rows behind them, folded into the items read. */
export interface WatchState {
  compromised: number;
  weak: number;
  reused: number;
  items: LockerRow[];
}

/** Which slice of the window the Items route is showing. `type:<t>` and
 *  `tag:<t>` carry their token the way the rail's rows name them. */
export type ItemFilter =
  | { kind: "all" }
  | { kind: "starred" }
  | { kind: "review" }
  /** The rows behind ONE of Review's verdicts — what *Show them* opens, so a
   *  count that was pressed and the list that answers it are one derivation
   *  (`format.matchesCheck`). */
  | { kind: "verdict"; check: CheckKey }
  | { kind: "type"; type: LockerItemType }
  | { kind: "tag"; tag: string }
  /** The archived shelf. NOT a client-side slice of the window: the items read
   *  is re-run with `archived: true`, because archived items are out of the
   *  default window by construction and filtering rows that were never fetched
   *  would draw an empty shelf over a full one. */
  | { kind: "archived" };

/** One field of the item screen, as the field-row recipe draws it. */
export interface ItemField {
  /** The key column's word. */
  key: string;
  /** The reveal identity — the permit is minted for exactly this. Absent on a
   *  metadata row, which is what makes "this row needs no permit" structural. */
  secretField?: string;
  /** A metadata value, shown plainly. Sealed rows carry none until revealed. */
  value?: string | null;
  /** The rule this row carries, in the app's own words. */
  note?: string;
  /** Read in the numeric register — an expiry, a one-time code. */
  numeric?: boolean;
}

/**
 * The add / edit form's seed. It can hold a TYPED secret — a password the
 * member is halfway through entering — which is why it is one of the
 * secret-bearing fields a lock wipes (session.ts `SECRET_BEARING_KEYS`).
 */
export interface ItemDraftSeed {
  mode: "new" | "edit";
  itemId?: string;
  type: LockerItemType;
  title: string;
  tags: string;
  alias: string;
  urlMatchPolicy: UrlMatchPolicy;
  fields: Record<string, string>;
}

/** A verdict chip on a row: `WEAK`, `REUSED` in the seam, `COMPROMISED` in
 *  `--net`. `null` where there is no verdict, never an empty chip. */
export interface Verdict {
  label: string;
  tone: "net" | "seam";
}
