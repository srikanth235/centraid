// Shared page-side shapes for the tally app (TS conversion). Type-only — no
// runtime members — so every importer uses `import type`, which esbuild strips
// at serve time (a value import of this module would 404). Grounded in the
// query payloads (queries/*.js) and the modal models logic.ts builds: money is
// always INTEGER minor units, balances are derived server-side and never stored.

/** A person resolved from the loaded snapshots (owner or a friend). */
export interface Person {
  party_id: string;
  name: string;
  color: string;
  initials: string;
  is_me?: boolean;
}

/** A friend on the dashboard / friend view — a person plus their net balance. */
export interface Friend extends Person {
  net_minor: number;
}

/** A group member (group view / modal member list) — a person plus their net. */
export interface Member extends Person {
  net_minor?: number;
}

/** A group card on the dashboard / sidebar (net folded to the owner's stance). */
export interface Group {
  group_id: string;
  name: string;
  icon?: string;
  color?: string;
  member_count: number;
  owner_net_minor: number;
}

/** The group meta a group-view payload carries (no member_count). */
export interface GroupMeta {
  group_id: string;
  name: string;
  icon?: string;
  color?: string;
}

/** One per-person split on a decorated ledger row. Optimistic rows carry the
 *  bare `{party_id, share_minor}`; fetched rows are decorated with name/color. */
export interface SplitEntry {
  party_id: string;
  share_minor: number;
  name?: string;
  color?: string;
  initials?: string;
}

/** The owner's stance on an expense. */
export type Role = 'lent' | 'borrowed' | 'none';

/** A decorated ledger/search row: an expense with the owner's lent/borrowed
 *  stance and its per-person splits. `pending`/`parked` mark optimistic adds. */
export interface LedgerRow {
  expense_id: string;
  group_id: string;
  group_name?: string;
  description: string;
  amount_minor: number;
  category: string;
  spent_on?: string;
  paid_by: string;
  paid_by_name?: string;
  your_role: Role;
  your_amount_minor: number;
  splits: SplitEntry[];
  pending?: boolean;
  parked?: boolean;
}

/** One interleaved activity entry (expense or settlement). */
export interface ActivityRow {
  kind: 'expense' | 'settlement';
  date?: string;
  description?: string;
  category?: string;
  group_name?: string;
  paid_by?: string;
  paid_by_name?: string;
  amount_minor?: number;
  your_role?: Role;
  your_amount_minor?: number;
  from_party?: string;
  from_name?: string;
  to_party?: string;
  to_name?: string;
  expense_id?: string;
  settlement_id?: string;
}

/** A first-class consent-denial outcome the UI renders as the access state. */
export interface VaultDenied {
  code?: string;
  message?: string;
}

/**
 * The sidebar/dashboard snapshot (`dash`) — never reassigned, only its fields
 * are mutated, so logic.ts's closure over it stays valid.
 */
export interface Dash {
  me: string | null;
  currency: string;
  friends: Friend[];
  groups: Group[];
  owe_total_minor: number;
  owed_total_minor: number;
}

/**
 * The dashboard query payload. The query always returns the full snapshot —
 * both the success and the denial path emit currency / friends / groups /
 * totals — so these stay required; only `me` (nullable) and `vaultDenied`
 * (present on a denial) vary.
 */
export interface DashboardPayload {
  me?: string | null;
  currency: string;
  friends: Friend[];
  groups: Group[];
  owe_total_minor: number;
  owed_total_minor: number;
  vaultDenied?: VaultDenied;
}

/**
 * The payload for the active detail view (group / friend / activity / search).
 * Every field is optional so one shape covers all four reads; render() reads
 * only the fields the current view populates.
 */
export interface ViewData {
  me?: string | null;
  currency?: string;
  group?: GroupMeta | null;
  members?: Member[];
  ledger?: LedgerRow[];
  friend?: Friend | null;
  activity?: ActivityRow[];
  results?: LedgerRow[];
  vaultDenied?: VaultDenied;
}

/** The add/edit expense modal model (state.expense). */
export interface ExpenseModel {
  mode: 'new' | 'edit';
  expense_id?: string;
  groupId: string;
  desc: string;
  amount: string;
  paidBy: string;
  method: 'equal' | 'exact' | 'percent';
  category: string;
  spent_on: string;
  include: Set<string>;
  exact: Record<string, string>;
  percent: Record<string, string>;
}

/** The settle-up modal model (state.settle). */
export interface SettleModel {
  people: Member[];
  from: string;
  to: string;
  amount: string;
  groupId: string | null;
}

/** The new-group modal model (state.newGroup). */
export interface NewGroupModel {
  name: string;
  icon: string;
  members: Set<string>;
}

/** The add-friend modal model (state.addFriend). */
export interface AddFriendModel {
  name: string;
}

/** The current top-level view. */
export type View = 'dashboard' | 'activity' | 'group' | 'friend';

/**
 * The module-level `state` bag app.tsx mutates in place (never reassigned) and
 * logic.ts closes over. All client-side presentation state — never persisted.
 */
export interface AppState {
  view: View;
  groupId: string | null;
  friendId: string | null;
  search: string;
  narrow: boolean;
  viewData: ViewData | null;
  detail: LedgerRow | null;
  expense: ExpenseModel | null;
  settle: SettleModel | null;
  newGroup: NewGroupModel | null;
  addFriend: AddFriendModel | null;
  modalMembers: Member[];
  pendingExpenses: LedgerRow[];
}

/** The nav patch setNav folds into `state` (a view switch). */
export interface NavPatch {
  view: View;
  groupId?: string | null;
  friendId?: string | null;
  search?: string;
}

/** The deps app.tsx hands createLogic (its state/dash plus render entry points). */
export interface LogicDeps {
  state: AppState;
  dash: Dash;
  render: () => void;
  renderModals: () => void;
  loadView: () => Promise<void>;
  refreshAll: () => Promise<void>;
}

/** The `{cls, label}` a balance-label helper returns. */
export interface BalLabel {
  cls: 'pos' | 'neg' | 'muted';
  label: string;
}

/** The `{bad, text}` the live split-sum line renders. */
export interface SplitSum {
  bad: boolean;
  text: string;
}
