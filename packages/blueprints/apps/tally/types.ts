export interface Person {
  party_id: string;
  name: string;
  color: string;
  initials: string;
  is_me?: boolean;
}

export interface Split extends Person {
  share_minor: number;
}

export type Role = "lent" | "borrowed" | "none";

export interface Payer extends Person {
  paid_minor: number;
}

export type SplitMethodName =
  | "equally"
  | "exact"
  | "percentages"
  | "shares"
  | "adjusted"
  | "by_line";

export interface LedgerEntry {
  expense_id: string;
  group_id: string | null;
  description?: string;
  amount_minor: number;
  original_amount_minor: number;
  original_currency: string;
  settlement_currency: string;
  rate_scaled: number;
  rate_scale: number;
  rate_source: string;
  rate_date?: string;
  recurring_template_id: string | null;
  category?: string;
  spent_on?: string;
  paid_by: string;
  paid_by_name: string;
  split_method?: SplitMethodName;
  split_params?: Record<string, unknown> | null;
  payers?: Payer[];
  line_items?: ReceiptLine[];
  your_role: Role;
  your_amount_minor: number;
  splits: Split[];
  group_name?: string;
  pending?: boolean;
  parked?: boolean;
  intentStatus?: string;
  pendingReason?: string;
  stewardLabel?: string;
  receipt?: Receipt;
}

export interface LineAllocation {
  party_id: string;
  name: string;
  share_minor: number;
}

export interface ReceiptLine {
  line_item_id: string;
  kind: "item" | "tax" | "tip";
  description: string;
  amount_minor: number;
  sort_order: number;
  allocations: LineAllocation[];
}

export interface Receipt {
  receipt_id: string;
  content_id: string;
  content_uri?: string;
  media_type?: string;
  lines: ReceiptLine[];
}

export interface WeightedSplit {
  party_id: string;
  weight: number;
}

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

export interface FriendSummary extends Person {
  net_minor: number;
  parts?: NetPart[];
}

export interface NetPart {
  group_id: string | null;
  group_name: string;
  net_minor: number;
}

export interface GroupSummary {
  group_id: string;
  name: string;
  icon?: string;
  color?: string;
  member_count: number;
  owner_net_minor: number;
  simplify_opt_in?: boolean;
  archived_at?: string | null;
}

export interface TrashEntry {
  expense_id: string;
  description: string;
  amount_minor: number;
  group_name: string;
  deleted_at: string;
  purge_at: string | null;
}

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
  paid_by?: string;
  category?: string;
  splits_json?: string;
  rrule?: string;
  anchor_start?: string;
  rate_scaled?: number | null;
  rate_scale?: number | null;
  rate_source?: string | null;
  rate_date?: string | null;
}

export interface VaultDenied {
  code?: string;
  message?: string;
  revoked_at?: string | null;
}

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
  archived_groups?: GroupSummary[];
  trash: TrashEntry[];
  recurring: RecurringTemplate[];
  owe_total_minor: number;
  owed_total_minor: number;
  expense_count?: number;
  settlement_count?: number;
  rate_suggestions?: RateSuggestion[];
  nudges?: Nudge[];
  vaultDenied?: VaultDenied | null;
}

export interface GroupMember extends Person {
  net_minor: number;
  departed?: boolean;
}

export interface Transfer {
  from: string;
  to: string;
  amount_minor: number;
}

export interface Simplification {
  opted_in: boolean;
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
