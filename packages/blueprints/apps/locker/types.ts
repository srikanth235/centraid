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
 * The six item-type discriminants Locker's schema recognizes (issue #712
 * C4) — the source of truth is the CHECK constraint on `locker_item.type`
 * (`packages/vault/src/schema/domains-locker.ts`). Kept in lockstep with it
 * by a source-scan tripwire (`locker-item-type.test.ts`), the same technique
 * `placement-registry.test.ts` uses for vault's `SHAREABLE_ITEM_TYPES`: this
 * file stays type-only (see above), so the union is restated here rather
 * than derived from a runtime array vault could export.
 */
export type LockerItemType =
  | "login"
  | "card"
  | "note"
  | "identity"
  | "wifi"
  | "password";

/** How a login's saved address is matched against a page (README §3). */
export type UrlMatchPolicy = "registrable-domain" | "exact-host";

/**
 * The five Review checks that have a producer today (README-Locker §5;
 * GAPS §3.3 #6a, #6b). The first three come from the vault's watchtower
 * aggregate, folded into the items read; the last two are pure reads of
 * metadata. The checks with NO producer are not in this union, on purpose —
 * they are copy on a screen, never a verdict a row can carry.
 */
export type CheckKey = "compromised" | "weak" | "reused" | "http" | "expiring";

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
}

/** Full, secret-bearing item — the single-item `item` query, and nothing else.
 *  A value of this type lives ONLY in the orchestrator's ref bag, and only
 *  while a permit's reveal is on screen (session.ts `SECRET_BEARING_KEYS`). */
export interface LockerDetail {
  item_id: string;
  type: LockerItemType;
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
  /** Connector alias (issue #298 item 4); not returned by the read today —
   *  the paper cut README-Locker §8 names, and a backend fix, not a UI one. */
  alias?: string | null;
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
  | { kind: "tag"; tag: string };

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
