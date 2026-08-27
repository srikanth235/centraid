// What Tally's six queries answer with, as the UI reads it.
//
// EVERY FIGURE IN THIS FILE ARRIVES DERIVED. `queries/dashboard.ts` holds the
// one balance engine — `pairwise`, `groupNet`, `ledgerRow` — and the interface
// never recomputes a net, a share or a total from the rows beside it. The
// shapes below therefore carry `*_minor` fields as FACTS the view renders, and
// the view's own folds (Spending's category totals, the day grouping on
// Activity) live in the `*-model.ts` modules, which take these as input and
// return display values, never balances.
//
// Minor units end to end. `format.ts` is the only place a number becomes a
// string.

/** One person, as every query decorates a row with them. */
export interface Person {
  party_id: string;
  name: string;
  color: string;
  initials: string;
  is_me?: boolean;
}

/** One share of one expense — a fact the vault stores, never a fold. */
export interface Split extends Person {
  share_minor: number;
}

/** The owner's stance on a ledger row: they fronted it, they owe a share of
 *  it, or the row is somebody else's business entirely. */
export type Role = "lent" | "borrowed" | "none";

/** One expense, as `ledgerRow()` hands it to the group, friend and search
 *  ledgers — decorated with the owner's stance, its splits, its currency
 *  provenance and, where a write has not settled, the pending overlay. */
/** One person who fronted part of an expense. Several is the ordinary shape
 *  now; one payer is the same shape with one row in it. */
export interface Payer extends Person {
  paid_minor: number;
}

/** How the shares were arrived at — the word `add-expense` recorded. */
export type SplitMethodName =
  | "equally"
  | "exact"
  | "percentages"
  | "shares"
  | "adjusted"
  | "by_line";

export interface LedgerEntry {
  expense_id: string;
  /** `null` on a group-less 1:1 expense. */
  group_id: string | null;
  description?: string;
  amount_minor: number;
  original_amount_minor: number;
  original_currency: string;
  settlement_currency: string;
  /** The supplied rate, as fixed point: `rate_scaled / 10 ** rate_scale`.
   *  `ledgerRow()` defaults it to identity where the expense was entered in
   *  the currency the group already settles in. */
  rate_scaled: number;
  rate_scale: number;
  rate_source: string;
  rate_date?: string;
  recurring_template_id: string | null;
  category?: string;
  spent_on?: string;
  paid_by: string;
  paid_by_name: string;
  /** The recorded division, and the numbers the member typed to get it. */
  split_method?: SplitMethodName;
  split_params?: Record<string, unknown> | null;
  /** Everyone who put money down, with the part each of them put. */
  payers?: Payer[];
  /** The typed lines behind the shares, receipt-backed or not. */
  line_items?: ReceiptLine[];
  /** The owner's stance, keyed off WHAT THEY PAID rather than off `paid_by`:
   *  with several payers the row is theirs if they fronted any of it. */
  your_role: Role;
  your_amount_minor: number;
  splits: Split[];
  /** Folded in by `search.ts`, which reads across every group. */
  group_name?: string;
  /** The pending overlay's own fields, present only on an unsettled write.
   *  Read through `_shared/pending-overlay.ts`, never by hand. */
  pending?: boolean;
  parked?: boolean;
  intentStatus?: string;
  pendingReason?: string;
  stewardLabel?: string;
  receipt?: Receipt;
}

/** One person's claim on one receipt line, as `ledgerRow()` decorates it. */
export interface LineAllocation {
  party_id: string;
  name: string;
  share_minor: number;
}

/** One line of a receipt. Tax and service are lines like any other — they are
 *  allocated the same way, and only the word differs. */
export interface ReceiptLine {
  line_item_id: string;
  kind: "item" | "tax" | "tip";
  description: string;
  amount_minor: number;
  sort_order: number;
  allocations: LineAllocation[];
}

/** A receipt attached to an expense. The bytes live once in the content spine;
 *  `content_uri` is the vault-blob path the shell's authenticated transport
 *  turns into something an `<img>` can load. */
export interface Receipt {
  receipt_id: string;
  content_id: string;
  content_uri?: string;
  media_type?: string;
  lines: ReceiptLine[];
}

/** One weighted share of a recurring template — the shape
 *  `save-recurring-expense` requires, and the shape `splits_json` holds. */
export interface WeightedSplit {
  party_id: string;
  weight: number;
}

/** One durable revision of an expense, as `queries/history.ts` answers.
 *  `undo_until` is when the one-shot window closes; `undone_at` marks a
 *  revision that has already been applied back. */
export interface Revision {
  revision_id: string;
  operation: string;
  snapshot: unknown;
  recorded_at: string;
  undo_until: string;
  undone_at?: string | null;
}

export interface HistoryData {
  revisions: Revision[];
  vaultDenied?: VaultDenied | null;
}

/** One friend on the dashboard: positive is owed TO you. */
export interface FriendSummary extends Person {
  net_minor: number;
  /** Where the net came from — one part per group, plus what is outside every
   *  group. The parts sum to the net, which is the only claim made about them. */
  parts?: NetPart[];
}

export interface NetPart {
  group_id: string | null;
  group_name: string;
  net_minor: number;
}

/** One group on the dashboard. `owner_net_minor` is the owner's own position
 *  in it, on the app's one sign convention. */
export interface GroupSummary {
  group_id: string;
  name: string;
  icon?: string;
  color?: string;
  member_count: number;
  owner_net_minor: number;
  /** Has this group turned simplification on? Off by default, always. */
  simplify_opt_in?: boolean;
  /** When it left the lists, or `null` while it is still in them. */
  archived_at?: string | null;
}

/** One trashed expense, with the date it stops being restorable. */
export interface TrashEntry {
  expense_id: string;
  description: string;
  amount_minor: number;
  group_name: string;
  deleted_at: string;
  purge_at: string | null;
}

/** One recurring template. `preview` is the schedule AS A SENTENCE; a rule the
 *  summariser cannot phrase leaves it empty, and then there is no preview at
 *  all rather than raw rule syntax on screen. */
export interface RecurringTemplate {
  template_id: string;
  group_id: string;
  description: string;
  original_amount_minor: number;
  original_currency: string;
  settlement_currency: string;
  time_zone: string;
  status: "active" | "paused" | "ended";
  preview?: string | null;
  next_start?: string | null;
  /** The rest of the stored row, which `queries/dashboard.ts` spreads through.
   *  Every act that rewrites a template needs all of it back (the command's
   *  input is the whole template, not a patch), so a row missing any of them
   *  withholds the act rather than sending a save that would be refused. */
  paid_by?: string;
  category?: string;
  /** The weighted splits, as the vault stores them: `[{party_id, weight}]`. */
  splits_json?: string;
  rrule?: string;
  anchor_start?: string;
  rate_scaled?: number | null;
  rate_scale?: number | null;
  rate_source?: string | null;
  rate_date?: string | null;
}

/** A denied read, as every query reports it. Denial is DATA — including the
 *  moment the grant went, where the gateway recorded one. */
export interface VaultDenied {
  code?: string;
  message?: string;
  revoked_at?: string | null;
}

/** One rate this vault has already been told, offered as a prefill. */
export interface RateSuggestion {
  from_currency: string;
  to_currency: string;
  rate_scaled: number;
  rate_scale: number;
  rate_source: string;
  rate_date: string;
  observed_on: string;
  expense_id: string;
}

/** One reminder the owner PREPARED. `sent` is stated and always false: Tally
 *  has no delivery path, and the record is the intention. */
export interface Nudge {
  nudge_id: string;
  party_id: string;
  group_id: string | null;
  prepared_at: string;
  note: string | null;
  sent: boolean;
}

export interface DashboardData {
  me: string | null;
  currency: string;
  friends: FriendSummary[];
  groups: GroupSummary[];
  /** Archived groups leave the main lists and keep everything, so they travel
   *  in their own array rather than being filtered into silence. */
  archived_groups?: GroupSummary[];
  trash: TrashEntry[];
  recurring: RecurringTemplate[];
  owe_total_minor: number;
  owed_total_minor: number;
  /** What the Balances hero states its arithmetic FROM. */
  expense_count?: number;
  settlement_count?: number;
  rate_suggestions?: RateSuggestion[];
  nudges?: Nudge[];
  vaultDenied?: VaultDenied | null;
}

/** One member of a group, with the net the group engine derived and, where
 *  they have left the circle but stayed on the ledger, the departed mark. */
export interface GroupMember extends Person {
  net_minor: number;
  departed?: boolean;
}

/** One payment the minimal-transfer fold proposes. DERIVED AT READ TIME and
 *  written nowhere: turning simplification on stores a flag, never a transfer. */
export interface Transfer {
  from: string;
  to: string;
  amount_minor: number;
}

export interface Simplification {
  opted_in: boolean;
  /** Empty until the group opts in, because it rewires who owes whom. */
  transfers: Transfer[];
  debts_before: number;
  payments_after: number;
}

export interface GroupData {
  me: string | null;
  currency: string;
  group: {
    group_id: string;
    name: string;
    icon?: string;
    color?: string;
    simplify_opt_in?: boolean;
    archived_at?: string | null;
  } | null;
  members: GroupMember[];
  ledger: LedgerEntry[];
  simplification?: Simplification;
  vaultDenied?: VaultDenied | null;
}

export interface FriendData {
  me: string | null;
  currency: string;
  friend: FriendSummary | null;
  ledger: LedgerEntry[];
  vaultDenied?: VaultDenied | null;
}

/** One row of the interleaved feed: an expense, or a settlement that happened.
 *  A settlement where neither party is the owner changes a balance and nothing
 *  else, which the row says out loud. */
export interface ActivityRow {
  kind: "expense" | "settlement";
  date?: string;
  description?: string;
  category?: string;
  group_name?: string;
  paid_by?: string;
  paid_by_name?: string;
  amount_minor: number;
  your_role?: Role;
  your_amount_minor?: number;
  from_party?: string;
  from_name?: string;
  to_party?: string;
  to_name?: string;
}

export interface ActivityData {
  me: string | null;
  currency: string;
  activity: ActivityRow[];
  vaultDenied?: VaultDenied | null;
}

/** One group's ledger as a file's worth of rows. Balances are excluded by
 *  design — they are arithmetic over these, and arithmetic travels in the rows. */
export interface ExportData {
  group: {
    group_id: string;
    name: string;
    icon?: string;
    color?: string;
    archived_at: string | null;
    members: { party_id: string; name: string }[];
  } | null;
  currency?: string;
  expenses: Record<string, unknown>[];
  settlements: Record<string, unknown>[];
  revisions: Record<string, unknown>[];
  balances_excluded: boolean;
  truncated: boolean;
  /** What the file holds and what bounded it: `since` is the inclusive ISO
   *  date floor the Range chip asked for, `null` when the chip said
   *  Everything. The counts are counts WITHIN that range. */
  window: {
    limit: number;
    since: string | null;
    expenses: number;
    settlements: number;
  };
  vaultDenied?: VaultDenied | null;
}

export interface SearchData {
  me: string | null;
  currency: string;
  results: LedgerEntry[];
  vaultDenied?: VaultDenied | null;
}
