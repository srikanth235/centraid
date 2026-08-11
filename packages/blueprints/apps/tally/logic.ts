// governance: allow-repo-hygiene file-size-limit (#408) pre-existing cohesive Tally business-logic module; the TS conversion only adds type annotations to the existing boundary and does not expand its behavior
// Non-visual business logic: vault IO (write/act/read), navigation, the
// people directory, and every modal's open/patch/save/close flow (expense,
// detail, settle, new-group, add-friend). `createLogic` closes over app.tsx's
// own `state`/`dash` (mutated in place, never reassigned) plus the
// render/renderModals/loadView/refreshAll entry points app.tsx defines — the
// same factory shape tasks/logic.ts and notes/logic.ts use.
//
// Every modal's fields (state.expense/settle/newGroup/addFriend) stay a
// plain mutable object patched via `Object.assign` + a full modal re-render,
// exactly like the original Lit app's `setE()` — the components are pure
// functions of that object, so a controlled input's `value` prop simply
// tracks it (no React `useState` needed for these, no Lit `live()` needed
// either: a full re-render already keeps the DOM in sync on every keystroke).
import { BRAND, identityColor, identityInitials } from "@centraid/design";

import {
  createPendingOverlayModel,
  pendingReasonCopy,
  pendingRowId,
} from "../_shared/pending-overlay.ts";
import type {
  PendingMutation,
  PendingRowState,
} from "../_shared/pending-overlay.ts";
import {
  convertMinor,
  first,
  rateToScaled,
  resolveSplits,
  toCents,
  todayKey,
} from "./format.ts";
import { debounce, outcomeMessage, statusLine } from "./kit.ts";
import { tallyPendingProjection } from "./pending-projection.ts";
import type {
  AddFriendModel,
  ExpenseModel,
  LedgerRow,
  LogicDeps,
  NavPatch,
  NewGroupModel,
  Person,
  Role,
  SettleModel,
  SplitEntry,
  VaultDenied,
  ViewData,
} from "./types.ts";

/** The ground fields an optimistic row and the write share. */
interface ExpenseBase {
  description: string;
  amount_minor: number;
  paid_by: string;
  category: string;
  spent_on: string;
  splits: SplitEntry[];
}

/** Parse a write's cached `splits` payload back into display split rows. */
function parseSplits(value: unknown): SplitEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): SplitEntry[] => {
    if (!item || typeof item !== "object") return [];
    const split = item as Record<string, unknown>;
    const partyId = typeof split.party_id === "string" ? split.party_id : "";
    const shareMinor = Number(split.share_minor);
    return partyId && Number.isFinite(shareMinor)
      ? [{ party_id: partyId, share_minor: shareMinor }]
      : [];
  });
}

/**
 * The money a pending add/edit-expense write implies for the owner — the
 * SAME arithmetic `queries/dashboard.ts`'s `ledgerRow()` runs against
 * canonical split rows, restated here because a pending write's splits are
 * not (and cannot be — `tally.expense_split`'s primary key is composite, so
 * the client can never mint its wire row id offline) part of the local
 * optimistic overlay the query composes over. Without this the query returns
 * the pending expense with `splits: {}`, and a $60 dinner split 50/50 renders
 * "you lent $60.00" until it settles.
 *
 * Returns undefined when the write carries no splits to reason from (a
 * delete, or a record whose input the outbox scrubbed on settle) — the row's
 * own values are then the most honest thing we have.
 */
function pendingExpenseMoney(
  input: Record<string, unknown>,
  me: string | null
): Pick<LedgerRow, "splits" | "your_role" | "your_amount_minor"> | undefined {
  const splits = parseSplits(input.splits);
  if (splits.length === 0) return undefined;
  const amountMinor = Number(input.amount_minor);
  const amount = Number.isFinite(amountMinor) ? amountMinor : 0;
  const paidBy = typeof input.paid_by === "string" ? input.paid_by : "";
  const mine = me == null ? undefined : splits.find((s) => s.party_id === me);
  let your_role: Role;
  let your_amount_minor: number;
  if (paidBy === me) {
    your_role = "lent";
    your_amount_minor = amount - (mine?.share_minor ?? 0);
  } else if (mine) {
    your_role = "borrowed";
    your_amount_minor = mine.share_minor;
  } else {
    your_role = "none";
    your_amount_minor = amount;
  }
  return { splits, your_role, your_amount_minor };
}

/**
 * Fold one row's pending-write overlay state (issue #738) into the display
 * fields `ExpenseRow`/`Ledger` read. `byRowId` is `logic.pendingByRowId()` —
 * a row whose id is not tracked (settled, or never pending) is returned
 * unchanged. Module-level and pure so app-root.tsx can map it over a fetched
 * ledger without re-deriving the index per row.
 *
 * `me` is the owner party the money is stated from (`dash.me`): a pending
 * row's `your_role`/`your_amount_minor`/`splits` are recomputed from the
 * write's cached input, because the query that composed the row could only
 * see the expense — never its splits.
 */
export function decorateLedgerRow(
  row: LedgerRow,
  byRowId: Map<string, PendingRowState>,
  me: string | null
): LedgerRow {
  const entry = byRowId.get(row.expense_id);
  if (!entry) return row;
  const money = entry.input ? pendingExpenseMoney(entry.input, me) : undefined;
  return {
    ...row,
    ...money, // undefined when the write carries no splits to reason from
    pending: true,
    parked: entry.status === "parked",
    pendingStatus: entry.status,
    pendingReason: pendingReasonCopy(entry.status, {
      reason: entry.reason,
      stewardLabel: entry.stewardLabel,
    }),
    ...(entry.stewardLabel ? { stewardLabel: entry.stewardLabel } : {}),
    // A refused write only offers Retry/Edit when its payload survived: the
    // outbox scrubs a settled intent's input, and a button that would
    // silently resend nothing is worse than no button (issue #738).
    ...(entry.input ? { pendingRetryable: true } : {}),
    // Edit reopens the expense composer with the refused payload — only
    // add/edit-expense have one; a refused delete has nothing to correct.
    ...(entry.input &&
    (entry.action === "add-expense" || entry.action === "edit-expense")
      ? { pendingEditable: true }
      : {}),
    ...(entry.conflict ? { pendingConflict: entry.conflict } : {}),
    commonsIntentId: entry.intentId,
  };
}

export function createLogic({
  state,
  dash,
  render,
  renderModals,
  loadView,
  refreshAll,
}: LogicDeps) {
  const $ = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;

  // The one pending-write model this app instance drives (issue #738). No app
  // state owns pending rows anymore — `rows()`/`byRowId()` are the read side,
  // `begin()`/`applyOutcome()`/`restore()`/`enrichCommons()` the write side.
  // Discarding (or taking for a retry/edit) an attention row also clears its
  // DURABLE record through the engine's one port: a row that comes back on
  // the next reload was never really discarded. The clear is fire-and-forget
  // by contract, so the failure is narrated here rather than swallowed.
  const model = createPendingOverlayModel(tallyPendingProjection, {
    dismissDurable: (intentId) => {
      const forget = window.centraid.dismissAttentionWrite;
      if (!forget) return;
      void forget({ intentId }).catch(() =>
        notice("That change is gone from this view but may return on reload.")
      );
    },
  });

  // ---------- Notice / consent narration ----------

  function notice(text: string) {
    const b = $("noticeBanner");
    b.textContent = text || "";
    b.hidden = !text;
  }

  // Returns true when the write executed; otherwise narrates parked / failed /
  // denied honestly and returns false.
  function narrate(outcome: VaultOutcome | undefined) {
    if (outcome?.status === "executed") {
      notice("");
      return true;
    }
    notice(outcomeMessage(outcome) ?? "The write did not go through.");
    return false;
  }

  // Mint an intent id and project it through the app's declaration BEFORE the
  // write is sent — the caller can close a modal / render the optimistic row
  // immediately, then hand the result to `act()` so it is not re-projected.
  function beginWrite(
    action: string,
    input: Record<string, unknown>
  ): { intentId: string; optimistic: PendingMutation[] } {
    const intentId = globalThis.crypto.randomUUID();
    return { intentId, optimistic: model.begin(action, input, intentId) };
  }

  /** Writes that change an expense row that already exists — the ones a
   *  second device can race. A create has nothing to be stale against. */
  const VERSIONED_ACTIONS = new Set(["edit-expense", "delete-expense"]);

  /**
   * The optimistic-concurrency precondition for one write (issue #738 P2):
   * the version of the `tally.expense` row this device composed the change
   * against, read from the local replica. Without it a conflict cannot even
   * occur — the vault has nothing to compare — so this is what makes a
   * `conflict` outcome, and its expected-vs-actual row, reachable at all.
   *
   * Empty is the honest answer for a create, for a host with no version
   * surface, and for a row the replica cannot address (an unsettled
   * `pending-*` id). `tally.expense_split` is deliberately never versioned:
   * its wire row id is a server HMAC this client cannot mint (see
   * pending-projection.ts), so there is no id to ask about.
   */
  async function baseVersionsFor(
    action: string,
    input: Record<string, unknown>
  ): Promise<CentraidBaseVersion[]> {
    const expenseId = input.expense_id;
    if (!VERSIONED_ACTIONS.has(action) || typeof expenseId !== "string")
      return [];
    const readVersion = window.centraid.rowVersion;
    if (!readVersion) return [];
    const version = await readVersion({
      entity: "tally.expense",
      rowId: expenseId,
    });
    return version === undefined
      ? []
      : [{ entity: "tally.expense", rowId: expenseId, version }];
  }

  async function act(
    action: string,
    input: Record<string, unknown>,
    begun?: { intentId: string; optimistic: PendingMutation[] }
  ): Promise<VaultOutcome | undefined> {
    const { intentId, optimistic } = begun ?? beginWrite(action, input);
    try {
      const baseVersions = await baseVersionsFor(action, input);
      const outcome = await window.centraid.write({
        action,
        input,
        intentId,
        ...(optimistic.length ? { optimistic } : {}),
        ...(baseVersions.length > 0 ? { baseVersions } : {}),
      });
      model.applyOutcome(intentId, outcome ?? { status: "failed" });
      return outcome;
    } catch (error) {
      model.applyOutcome(intentId, { status: "failed" });
      notice(String((error as { message?: string })?.message ?? error));
      return undefined;
    }
  }

  async function read<T = ViewData>(
    query: string,
    input?: Record<string, unknown>
  ): Promise<T> {
    return window.centraid.read<T>({ query, input: input ?? {} });
  }

  function applyDenied(denied: VaultDenied) {
    $("consentBanner").hidden = false;
    $("consentDetail").textContent = denied.message ?? "";
    $("root").classList.add("denied");
  }

  // ---------- People lookups (from the loaded snapshots) ----------

  // A directory of everyone we know about across the loaded snapshots, so any
  // party id resolves to a name/color/initials even outside its home view.
  function directory(): Map<string, Person> {
    const map = new Map<string, Person>();
    const put = (p: Person | undefined) => {
      if (p && p.party_id && !map.has(p.party_id)) map.set(p.party_id, p);
    };
    for (const f of dash.friends) put(f);
    for (const m of state.modalMembers) put(m);
    if (state.viewData) {
      for (const m of state.viewData.members ?? []) put(m);
      if (state.viewData.friend) put(state.viewData.friend);
    }
    if (dash.me && !map.has(dash.me))
      map.set(dash.me, {
        party_id: dash.me,
        name: "You",
        color: BRAND,
        initials: identityInitials("You"),
      });
    return map;
  }
  function personOf(pid: string): Person {
    return (
      directory().get(pid) || {
        party_id: pid,
        name: "Someone",
        color: identityColor(pid),
        initials: identityInitials("Someone"),
      }
    );
  }
  function displayName(pid: string): string {
    return pid === dash.me ? "You" : personOf(pid).name;
  }
  function shortName(pid: string): string {
    return pid === dash.me ? "you" : first(personOf(pid).name);
  }

  // ---------- View navigation ----------

  function setNav(patch: NavPatch) {
    Object.assign(state, patch);
    state.detail = null;
    if (state.narrow) $("root").classList.remove("side-open");
    void loadView();
  }

  // ---------- Search ----------
  //
  // Status tracking (issue #712 S1): `state.searchStatus` is the same four-
  // state union Photos' `search.ts` derives (`_shared/search-scaffold.ts`'s
  // `SearchStatus`), so `components/Search.tsx` renders through the shared
  // `SearchScaffold` instead of Tally growing its own "no results" grammar.
  // `reached` mirrors Photos' own `try { } catch { reached = false }` — a
  // thrown read means the gateway could not be reached, not that nothing
  // matched, and the two must never collapse into the same sentence.

  let searchSeq = 0;

  async function runSearch(q: string): Promise<void> {
    const seq = ++searchSeq;
    state.searchStatus = "searching";
    render(); // paint the "Results for…" chrome + skeleton
    let res: ViewData | null = null;
    let reached = true;
    try {
      res = await read("search", { term: q });
    } catch {
      res = { results: [] };
      reached = false;
    }
    if (seq !== searchSeq) return; // superseded by a newer keystroke or retry
    if (res?.me) dash.me = res.me;
    state.viewData = res;
    state.searchStatus = reached ? "ready" : "unreachable";
    render();
  }

  const applySearch = debounce(async () => {
    const q = ($("searchInput") as HTMLInputElement).value.trim();
    if (q === state.search) return;
    state.search = q;
    if (!q) {
      state.viewData = null;
      state.searchStatus = "resting";
      searchSeq += 1;
      await loadView();
      return;
    }
    await runSearch(q);
  }, 150);

  // Re-runs the CURRENT query rather than navigating anywhere — the
  // `unreachable` panel's only control, and the one place a stale `reached:
  // false` gets a chance to become true without the member retyping.
  function retrySearch(): void {
    const q = state.search.trim();
    if (!q) return;
    void runSearch(q);
  }

  // Fills the field and searches immediately — the resting panel's example
  // chips (`components/Search.tsx`'s `onQuery`). The field itself is
  // uncontrolled (Chrome.tsx has no `value` prop; `applySearch` reads it live
  // off the DOM), so a chip click has to write the DOM value too, the same
  // way `clearSearch` already does for the opposite direction.
  function searchFor(term: string): void {
    const input = $("searchInput") as HTMLInputElement;
    input.value = term;
    state.search = term;
    void runSearch(term);
  }

  function clearSearch() {
    const input = $("searchInput") as HTMLInputElement;
    if (!input.value && !state.search) return;
    input.value = "";
    searchSeq += 1;
    state.search = "";
    state.searchStatus = "resting";
    void loadView();
  }

  // ---------- Expense detail popover ----------

  function openDetail(row: LedgerRow) {
    state.detail = row;
    renderModals();
  }
  function closeDetail() {
    state.detail = null;
    renderModals();
  }

  // ---------- Add / edit expense modal ----------

  // Load a group's members into state.modalMembers, then re-render the modal.
  async function loadModalMembers(groupId: string) {
    try {
      const res = await read("group", { group_id: groupId });
      if (res?.me) dash.me = res.me;
      // Departed people stay in the group query for historical ledger
      // balances, but cannot be selected for a new/changed expense.
      state.modalMembers = (res?.members ?? []).filter(
        (member) => !member.departed
      );
    } catch {
      state.modalMembers = [];
    }
    renderModals();
  }

  async function openAddExpense() {
    closeAllModals();
    // Default to the active group, else the first group.
    const gid =
      state.view === "group" ? state.groupId : dash.groups[0]?.group_id;
    if (!gid) {
      notice("Create a group first — expenses live inside a group.");
      return;
    }
    state.expense = {
      mode: "new",
      groupId: gid,
      desc: "",
      amount: "",
      originalCurrency: dash.currency,
      settlementCurrency: dash.currency,
      rate: "1",
      rateSource: "identity",
      rateDate: todayKey(),
      recurring: false,
      rrule: "FREQ=MONTHLY",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      paidBy: dash.me ?? "",
      method: "equal",
      category: "general",
      spent_on: todayKey(),
      include: new Set<string>(),
      exact: {},
      percent: {},
    };
    await loadModalMembers(gid);
    // Include everyone by default.
    state.expense.include = new Set(state.modalMembers.map((m) => m.party_id));
    renderModals();
  }

  async function openEditExpense(row: LedgerRow) {
    closeAllModals();
    const include = new Set((row.splits ?? []).map((s) => s.party_id));
    const exact: Record<string, string> = {};
    for (const s of row.splits ?? [])
      exact[s.party_id] = (s.share_minor / 100).toFixed(2);
    state.expense = {
      mode: "edit",
      expense_id: row.expense_id,
      groupId: row.group_id,
      desc: row.description,
      amount: (row.amount_minor / 100).toFixed(2),
      originalCurrency: row.original_currency ?? dash.currency,
      settlementCurrency: row.settlement_currency ?? dash.currency,
      rate:
        row.rate_scaled && row.rate_scale != null
          ? String(row.rate_scaled / 10 ** row.rate_scale)
          : "1",
      rateSource: row.rate_source ?? "identity",
      rateDate: row.rate_date ?? row.spent_on ?? todayKey(),
      recurring: false,
      rrule: "FREQ=MONTHLY",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      paidBy: row.paid_by,
      method: "exact", // edit lands on exact so the existing shares show
      category: row.category || "general",
      spent_on: row.spent_on || todayKey(),
      include,
      exact,
      percent: {},
    };
    await loadModalMembers(row.group_id);
    renderModals();
  }

  function closeExpense() {
    state.expense = null;
    renderModals();
  }
  function setExpense(patch: Partial<ExpenseModel>) {
    Object.assign(state.expense!, patch);
    renderModals();
  }
  // The expense modal's Group select: switching groups reloads that group's
  // members, resets who's included to "everyone", and falls back paid-by to
  // "me" if the previous payer isn't a member of the newly-chosen group.
  async function setExpenseGroup(groupId: string) {
    const exp = state.expense!;
    exp.groupId = groupId;
    await loadModalMembers(groupId);
    exp.include = new Set(state.modalMembers.map((m) => m.party_id));
    if (!state.modalMembers.some((m) => m.party_id === exp.paidBy))
      exp.paidBy = dash.me ?? "";
    renderModals();
  }

  // ---------- Pending-write overlay (issue #738) ----------

  /**
   * Synthesize the full ledger row a pending add-expense needs (issue #738)
   * from the entry's cached `input` — the same fields `refreshCommonsExpenses`
   * used to decorate durable Commons rows before this migration. Two kinds of
   * entry need it: a commons-enrichment-only intent (another device's
   * steward-parked write, which has no local outbox mutation at all), and a
   * locally-queued write on a ledger whose query cannot return it (the friend
   * ledger joins on `tally.expense_split`, which is deliberately unprojected).
   */
  function buildPendingRow(entry: PendingRowState): LedgerRow | undefined {
    if (entry.action !== "add-expense" || !entry.input) return undefined;
    const raw = entry.input;
    const groupId = typeof raw.group_id === "string" ? raw.group_id : "";
    const description =
      typeof raw.description === "string" ? raw.description : "";
    const paidBy = typeof raw.paid_by === "string" ? raw.paid_by : "";
    const amountMinor = Number(raw.amount_minor);
    if (!groupId || !description || !paidBy || !Number.isFinite(amountMinor))
      return undefined;
    const money = pendingExpenseMoney(raw, dash.me);
    return {
      expense_id: pendingRowId(entry.intentId),
      group_id: groupId,
      group_name: dash.groups.find((g) => g.group_id === groupId)?.name ?? "",
      description,
      amount_minor: amountMinor,
      paid_by: paidBy,
      paid_by_name: displayName(paidBy),
      category: typeof raw.category === "string" ? raw.category : "general",
      spent_on: typeof raw.spent_on === "string" ? raw.spent_on : todayKey(),
      splits: money?.splits ?? [],
      your_role: money?.your_role ?? "none",
      your_amount_minor: money?.your_amount_minor ?? amountMinor,
    };
  }

  /** Every tracked add-expense write rendered as a ledger row (issue #738),
   *  decorated with its chip — local and commons-enrichment-only alike.
   *  `pendingLedgerRowsForView` decides which of them a given view still
   *  needs; a row the query already composed is dropped there, not here. */
  function pendingLedgerRows(): LedgerRow[] {
    const byRowId = model.byRowId();
    return model.rows().flatMap((entry) => {
      const row = buildPendingRow(entry);
      return row ? [decorateLedgerRow(row, byRowId, dash.me)] : [];
    });
  }

  /**
   * The pending rows the ACTIVE view still needs appended to its fetched
   * ledger (issue #738).
   *
   * A locally-queued write is normally already IN `state.viewData.ledger` —
   * the replica composes the projected `tally.expense` row from the outbox on
   * every read — so anything the fetched ledger already carries is dropped
   * here rather than rendered twice. The friend ledger is the case that
   * needs it: `queries/friend.ts` selects on `splits[friend] && splits[me]`,
   * and a pending expense has no split rows (deliberately unprojected), so
   * the query can never return it and the row would otherwise vanish from
   * that view until it settled.
   */
  function pendingLedgerRowsForView(): LedgerRow[] {
    const extra = pendingLedgerRows();
    if (extra.length === 0) return [];
    const fetched = new Set(
      (state.viewData?.ledger ?? []).map((row) => row.expense_id)
    );
    const rows = extra.filter((row) => !fetched.has(row.expense_id));
    if (state.view === "group")
      return rows.filter((row) => row.group_id === state.groupId);
    if (state.view === "friend")
      return rows.filter(
        (row) =>
          row.paid_by === state.friendId ||
          row.splits.some((split) => split.party_id === state.friendId)
      );
    return [];
  }

  function pendingByRowId(): Map<string, PendingRowState> {
    return model.byRowId();
  }

  /**
   * The owe/owed delta from add-expense writes still in flight (queued or
   * sending — a parked write hasn't moved any balance yet). The dashboard
   * query cannot already see this itself: its balance engine reads
   * `tally.expense_split`, and a pending row has no split rows in the
   * overlay (see `pendingExpenseMoney`) for it to fold in.
   */
  function inflightBalance(): { owe: number; owed: number } {
    let owe = 0;
    let owed = 0;
    for (const entry of model.rows()) {
      if (entry.action !== "add-expense") continue;
      if (entry.status !== "queued" && entry.status !== "sending") continue;
      if (!entry.input) continue;
      const money = pendingExpenseMoney(entry.input, dash.me);
      if (!money) continue;
      if (money.your_role === "lent") owed += money.your_amount_minor;
      else if (money.your_role === "borrowed") owe += money.your_amount_minor;
    }
    return { owe, owed };
  }

  /** Rebuild the overlay from local truth — the reload path (issue #738).
   *  TWO durable sources, because a settled write leaves the outbox: the
   *  outbox for what is still in flight, the attention journal for what came
   *  back denied/conflicted/failed. Feature-detected: absent on the
   *  visual-harness mock and older hosts, in which case attention rows
   *  persist only in-session from `applyOutcome`.
   *
   *  `window.centraid` itself is optional here, not defensively: a remount
   *  tears the inline bridge down before the next one installs, so a refresh
   *  already in flight can legitimately outlive the client it started on. */
  async function restorePendingWrites(): Promise<void> {
    const [pending, attention] = await Promise.all([
      window.centraid?.pendingWrites?.(),
      window.centraid?.attentionWrites?.(),
    ]);
    // An absent answer is NOT an empty outbox. `restore` prunes rows the
    // durable list omits, so folding "no host surface" or "bridge torn down"
    // into `[]` would delete every queued row — the wipe class #738 exists
    // to end, merely moved from the commons rail to the outbox rail.
    if (pending) model.restore(pending);
    if (attention) model.restoreAttention(attention);
  }

  /**
   * Commons is enrichment only now (issue #738): steward label and
   * per-grant status onto rows the outbox already tracks, plus
   * enrichment-only rows for another device's parked write — never a
   * rebuild. An offline/failed fetch is silently skipped so every row still
   * renders from the outbox alone.
   */
  async function enrichCommons(): Promise<void> {
    try {
      model.enrichCommons((await window.centraid.commonsIntents?.()) ?? []);
    } catch {
      // Offline or unreachable: rows still render from the outbox alone.
    }
  }

  /** Drive the model from one change-feed event (issue #738); the app
   *  re-renders when it reports a change. Canonical bursts stay the
   *  doorbell's business (a full refresh still follows). */
  function applyChangeDetail(detail: CentraidChangeDetail): boolean {
    return model.applyChangeDetail(detail);
  }

  /**
   * Settle a terminal (denied/conflict/failed) pending row out of the
   * ledger for good (issue #731 m6, extended by #738) — a no-op for a row
   * still waiting, so nothing genuinely in flight can be dismissed away.
   */
  function dismissCommonsIntent(intentId: string) {
    if (!model.dismiss(intentId)) return;
    render();
  }

  /**
   * Re-issue a refused write under a FRESH intent id (issue #738): the old
   * id's payload hash is bound to the attempt that failed, so replaying it
   * would dedupe onto that failure instead of trying again. `takeForRetry`
   * drops the old entry AND its durable record, so the reload after a retry
   * shows one row, not two.
   */
  async function retryPendingWrite(
    intentId: string
  ): Promise<VaultOutcome | undefined> {
    const retry = model.takeForRetry(intentId);
    if (!retry) return undefined;
    render();
    // No banner narration here: whatever the resend settles as lands back on
    // the row itself, with its own reason and its own answer. Saying it twice
    // would make one refusal look like two.
    const outcome = await act(retry.action, retry.input);
    render();
    return outcome;
  }

  /** The group an edit-expense payload belongs to. `edit-expense` does not
   *  carry `group_id` (the command re-derives it), so it is read off the row
   *  the ledger already holds; null when this device cannot say, in which
   *  case no Edit is offered rather than one that opens the wrong group. */
  function expenseGroupOf(input: Record<string, unknown>): string | null {
    if (typeof input.group_id === "string" && input.group_id)
      return input.group_id;
    const expenseId = input.expense_id;
    if (typeof expenseId !== "string") return null;
    const row = (state.viewData?.ledger ?? []).find(
      (candidate) => candidate.expense_id === expenseId
    );
    return row?.group_id ?? (state.view === "group" ? state.groupId : null);
  }

  /**
   * The third answer the status grammar promises beside retry and discard:
   * open the expense composer PREFILLED with the refused payload, so a write
   * the vault would refuse again can be corrected before it is resent. The
   * entry is taken (record included) exactly like a retry — the modal now
   * holds the payload, and saving it issues a fresh intent.
   *
   * Only add/edit-expense have a composer to reopen; `delete-expense` carries
   * nothing to correct, so `decorateLedgerRow` marks no Edit for it rather
   * than offering a button that would do nothing.
   */
  async function editPendingWrite(intentId: string): Promise<void> {
    const entry = model.rows().find((row) => row.intentId === intentId);
    if (!entry?.input) return;
    // Resolve everything the composer needs BEFORE taking the entry: taking
    // it clears the durable record, so a bail-out afterwards would delete the
    // very row the member asked to correct.
    const groupId = expenseGroupOf(entry.input);
    if (groupId === null) {
      notice("Open the group this expense belongs to, then edit it there.");
      return;
    }
    const taken = model.takeForRetry(intentId);
    if (!taken) return;
    const raw = taken.input;
    const splits = parseSplits(raw.splits);
    const num = (value: unknown, fallback: number) =>
      Number.isFinite(Number(value)) ? Number(value) : fallback;
    const amountMinor = num(raw.amount_minor, 0);
    const rateScaled = num(raw.rate_scaled, 1_000_000);
    const rateScale = num(raw.rate_scale, 6);
    const text = (key: string, fallback: string) =>
      typeof raw[key] === "string" && raw[key]
        ? (raw[key] as string)
        : fallback;
    closeAllModals();
    state.expense = {
      mode: taken.action === "edit-expense" ? "edit" : "new",
      ...(typeof raw.expense_id === "string"
        ? { expense_id: raw.expense_id }
        : {}),
      groupId,
      desc: text("description", ""),
      amount: (num(raw.original_amount_minor, amountMinor) / 100).toFixed(2),
      originalCurrency: text("original_currency", dash.currency),
      settlementCurrency: text("settlement_currency", dash.currency),
      rate: String(rateScaled / 10 ** rateScale),
      rateSource: text("rate_source", "identity"),
      rateDate: text("rate_date", text("spent_on", todayKey())),
      recurring: false,
      rrule: "FREQ=MONTHLY",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      paidBy: text("paid_by", dash.me ?? ""),
      // Exact shares, so the refused split survives the round trip verbatim —
      // re-deriving "equal" would silently rewrite the member's own numbers.
      method: "exact",
      category: text("category", "general"),
      spent_on: text("spent_on", todayKey()),
      include: new Set(splits.map((split) => split.party_id)),
      exact: Object.fromEntries(
        splits.map((split) => [
          split.party_id,
          (split.share_minor / 100).toFixed(2),
        ])
      ),
      percent: {},
    };
    render();
    await loadModalMembers(groupId);
  }

  /**
   * Cancel a durable Commons intent that has not executed yet (issue #731
   * goal 2) — meaningful only while it is still `parked`; a no-op
   * otherwise. A genuine race with the steward (or the peer sweep retrying a
   * parked intent) is possible, so this never assumes the cancel won: it
   * re-enriches afterward and lets the row show whatever actually settled —
   * cancelled, or the steward's real answer if the race was lost.
   */
  async function cancelCommonsIntent(intentId: string) {
    const entry = model.rows().find((row) => row.intentId === intentId);
    if (!entry || entry.status !== "parked") return;
    const cancel = window.centraid.cancelCommonsIntent;
    if (!cancel) return;
    try {
      await cancel({ intentId });
    } catch {
      // A transport failure leaves the row exactly as it was; the re-enrich
      // below (or the member's next action) reconciles it either way.
    }
    await enrichCommons();
    render();
  }

  async function saveExpense() {
    const exp = state.expense!;
    const originalCents = toCents(exp.amount);
    const originalCurrency = exp.originalCurrency.trim().toUpperCase();
    const settlementCurrency = exp.settlementCurrency.trim().toUpperCase();
    const rateScaled =
      originalCurrency === settlementCurrency
        ? 1_000_000
        : rateToScaled(exp.rate);
    const cents = convertMinor(originalCents, rateScaled);
    const splits = resolveSplits(exp, cents, state.modalMembers);
    if (
      !exp.desc.trim() ||
      cents <= 0 ||
      !splits ||
      originalCurrency.length !== 3 ||
      settlementCurrency.length !== 3 ||
      (originalCurrency !== settlementCurrency &&
        (!exp.rateSource.trim() || !exp.rateDate))
    )
      return;
    const base: ExpenseBase = {
      description: exp.desc.trim(),
      amount_minor: cents,
      paid_by: exp.paidBy,
      category: exp.category,
      spent_on: exp.spent_on,
      splits,
    };
    const currencyFields = {
      original_amount_minor: originalCents,
      original_currency: originalCurrency,
      settlement_currency: settlementCurrency,
      rate_scaled: rateScaled,
      rate_scale: 6,
      rate_source:
        originalCurrency === settlementCurrency
          ? "identity"
          : exp.rateSource.trim(),
      rate_date: exp.rateDate || exp.spent_on,
    };
    if (exp.mode === "new" && exp.recurring) {
      const anchorStart = new Date(`${exp.spent_on}T09:00:00`).toISOString();
      const template = await act("save-recurring-expense", {
        group_id: exp.groupId,
        description: base.description,
        paid_by: base.paid_by,
        category: base.category,
        splits: splits.map((split) => ({
          party_id: split.party_id,
          weight: Math.max(1, split.share_minor),
        })),
        rrule: exp.rrule,
        anchor_start: anchorStart,
        time_zone: exp.timeZone,
        ...currencyFields,
      });
      if (!narrate(template)) return;
      const templateId = String(template?.output?.template_id ?? "");
      const materialized = await act("materialize-recurring-expense", {
        template_id: templateId,
        original_start: anchorStart,
      });
      if (!narrate(materialized)) return;
      statusLine(
        `${String(template?.output?.preview ?? "Recurring expense")} · first occurrence recorded`
      );
      closeExpense();
      await refreshAll();
      return;
    }
    if (exp.mode === "edit") {
      // Edit is the cold path — patching a fetched row in place is not worth
      // the divergence risk, so it keeps the plain write→narrate→refresh flow.
      const outcome = await act("edit-expense", {
        expense_id: exp.expense_id,
        ...base,
        ...currencyFields,
      });
      if (!narrate(outcome)) return;
      armExpenseUndo(outcome, "Expense updated.");
      statusLine("Expense updated · receipted.");
      closeExpense();
      await refreshAll();
      return;
    }
    // Optimistic add — the hot path (issue #404 → the shared pending-write
    // overlay, issue #738). `beginWrite` projects the pending tally.expense
    // row before the write is even sent, so the modal closes and the row
    // renders at zero perceived round trips; there is no local row object to
    // reconcile by hand — the query composes the row from the outbox on
    // every read, and `render()` re-reads the model's current status:
    //   executed        → the doorbell refetches; the model drops the entry
    //                      and the canonical row takes over.
    //   queued/sending/
    //   parked/failed/
    //   denied/conflict → the row persists with its chip and reason,
    //                      exactly per the shared status grammar.
    const input: Record<string, unknown> = {
      group_id: exp.groupId,
      ...base,
      ...currencyFields,
    };
    const begun = beginWrite("add-expense", input);
    closeExpense();
    render();
    const outcome = await act("add-expense", input, begun);
    if (outcome?.status === "executed") {
      notice("");
      statusLine("Expense added · receipted.");
    } else if (outcome) {
      narrate(outcome);
    }
    render();
  }

  async function deleteExpense(expenseId: string) {
    const outcome = await act("delete-expense", { expense_id: expenseId });
    if (!narrate(outcome)) return;
    armExpenseUndo(outcome, "Expense moved to Trash.");
    statusLine("Expense deleted · receipted.");
    closeAllModals();
    // closeAllModals() only nulls the state — every other caller follows it
    // with its own renderModals(), and render()/refreshAll() never touch
    // #modalRoot, so without this the detail/edit modal for the now-deleted
    // expense stays painted on screen until something else repaints modals.
    renderModals();
    await refreshAll();
  }

  function armExpenseUndo(outcome: VaultOutcome | undefined, label: string) {
    const revisionId = String(outcome?.output?.revision_id ?? "");
    const expenseId = String(outcome?.output?.expense_id ?? "");
    const until = String(outcome?.output?.undo_until ?? "");
    if (!revisionId || !expenseId || !until) return;
    state.expenseUndo = { expenseId, revisionId, until, label };
    render();
    const delay = Math.max(0, Date.parse(until) - Date.now());
    setTimeout(() => {
      if (state.expenseUndo?.revisionId !== revisionId) return;
      state.expenseUndo = null;
      render();
    }, delay + 50);
  }

  async function undoExpense(expenseId: string, revisionId: string) {
    const outcome = await act("undo-expense", {
      expense_id: expenseId,
      revision_id: revisionId,
    });
    if (!narrate(outcome)) return;
    state.expenseUndo = null;
    closeAllModals();
    renderModals();
    statusLine("Expense change undone · receipted.");
    await refreshAll();
  }

  async function restoreExpense(expenseId: string) {
    const outcome = await act("restore-expense", { expense_id: expenseId });
    if (!narrate(outcome)) return;
    statusLine("Expense restored · receipted.");
    await refreshAll();
  }

  async function materializeRecurringExpense(
    templateId: string,
    originalStart: string
  ): Promise<void> {
    const outcome = await act("materialize-recurring-expense", {
      template_id: templateId,
      original_start: originalStart,
    });
    if (!narrate(outcome)) return;
    statusLine(
      outcome?.output?.status === "existing"
        ? "Occurrence was already recorded."
        : "Recurring expense recorded · receipt"
    );
    await refreshAll();
  }

  async function editRecurringExpense(
    templateId: string,
    originalStart: string,
    scope: "occurrence" | "future" | "series",
    action: "skip" | "override",
    override?: Record<string, unknown>
  ): Promise<void> {
    const outcome = await act("edit-recurring-expense-occurrence", {
      template_id: templateId,
      original_start: originalStart,
      scope,
      action,
      ...(override ? { override } : {}),
    });
    if (!narrate(outcome)) return;
    statusLine(`Recurring ${scope} updated · receipt`);
    await refreshAll();
  }

  // ---------- Group management ----------

  async function renameGroup(groupId: string, name: string) {
    const outcome = await act("rename-group", {
      group_id: groupId,
      name,
    });
    if (!narrate(outcome)) return;
    statusLine("Group renamed · receipted.");
    await refreshAll();
  }

  async function addGroupMember(groupId: string, partyId: string) {
    const outcome = await act("add-group-member", {
      group_id: groupId,
      party_id: partyId,
    });
    if (!narrate(outcome)) return;
    statusLine("Member added · receipted.");
    await refreshAll();
  }

  async function removeGroupMember(groupId: string, partyId: string) {
    const outcome = await act("remove-group-member", {
      group_id: groupId,
      party_id: partyId,
    });
    if (!narrate(outcome)) return;
    statusLine("Member removed · receipted.");
    await refreshAll();
  }

  async function deleteGroup(groupId: string) {
    const outcome = await act("delete-group", { group_id: groupId });
    if (!narrate(outcome)) return;
    statusLine("Group deleted · receipted.");
    setNav({ view: "dashboard", groupId: null, search: "" });
    await refreshAll();
  }

  // ---------- Settle up ----------

  async function openSettle() {
    closeAllModals();
    if (state.view === "group" && state.groupId) {
      await loadModalMembers(state.groupId);
      const other = state.modalMembers.find((m) => m.party_id !== dash.me);
      state.settle = {
        people: state.modalMembers,
        from: other?.party_id ?? dash.me ?? "",
        to: dash.me ?? "",
        amount: "",
        groupId: state.groupId,
      };
    } else if (state.view === "friend" && state.viewData?.friend) {
      const f = state.viewData.friend;
      state.modalMembers = [
        {
          party_id: dash.me ?? "",
          name: "You",
          color: BRAND,
          initials: identityInitials("You"),
          is_me: true,
        },
        f,
      ];
      state.settle = {
        people: state.modalMembers,
        from: f.party_id,
        to: dash.me ?? "",
        amount: "",
        groupId: null,
      };
    } else {
      return;
    }
    renderModals();
  }
  function closeSettle() {
    state.settle = null;
    renderModals();
  }
  function setSettle(patch: Partial<SettleModel>) {
    Object.assign(state.settle!, patch);
    renderModals();
  }

  async function saveSettle() {
    const st = state.settle!;
    const cents = toCents(st.amount);
    if (cents <= 0 || st.from === st.to) return;
    const input: Record<string, unknown> = {
      from_party: st.from,
      to_party: st.to,
      amount_minor: cents,
      paid_on: todayKey(),
    };
    if (st.groupId) input.group_id = st.groupId;
    const outcome = await act("settle-up", input);
    if (!narrate(outcome)) return;
    statusLine("Payment recorded · receipted.");
    closeSettle();
    await refreshAll();
  }

  // ---------- New group ----------

  function openNewGroup() {
    closeAllModals();
    if (dash.friends.length === 0) {
      notice("Add a friend first — a group needs at least one other member.");
      openAddFriend();
      return;
    }
    state.newGroup = { name: "", icon: "🏠", members: new Set<string>() };
    renderModals();
  }
  function closeNewGroup() {
    state.newGroup = null;
    renderModals();
  }
  function setNewGroup(patch: Partial<NewGroupModel>) {
    Object.assign(state.newGroup!, patch);
    renderModals();
  }

  async function saveNewGroup() {
    const ng = state.newGroup!;
    if (!ng.name.trim() || ng.members.size < 1) return;
    const outcome = await act("create-group", {
      name: ng.name.trim(),
      icon: ng.icon,
      color: identityColor(ng.name.trim()),
      member_ids: [...ng.members],
    });
    if (!narrate(outcome)) return;
    const gid = outcome?.output?.group_id as string | undefined;
    statusLine("Group created · receipted.");
    closeNewGroup();
    await refreshAll();
    if (gid) setNav({ view: "group", groupId: gid, search: "" });
  }

  // ---------- Add friend (REQUIRED — a fresh vault starts empty) ----------

  function openAddFriend() {
    closeAllModals();
    // No colour field: a friend's hue is derived from the party (issue #441 A3),
    // not chosen and stored per Tally row.
    state.addFriend = { name: "" };
    renderModals();
  }
  function closeAddFriend() {
    state.addFriend = null;
    renderModals();
  }
  function setAddFriend(patch: Partial<AddFriendModel>) {
    Object.assign(state.addFriend!, patch);
    renderModals();
  }

  async function saveAddFriend() {
    const af = state.addFriend!;
    if (!af.name.trim()) return;
    const outcome = await act("add-friend", { name: af.name.trim() });
    if (!narrate(outcome)) return;
    statusLine("Friend added · receipted.");
    closeAddFriend();
    await refreshAll();
  }

  // ---------- Modal helpers ----------

  function closeAllModals() {
    state.detail = null;
    state.expense = null;
    state.settle = null;
    state.newGroup = null;
    state.addFriend = null;
  }
  function anyModalOpen() {
    return !!(
      state.detail ||
      state.expense ||
      state.settle ||
      state.newGroup ||
      state.addFriend
    );
  }

  return {
    notice,
    narrate,
    act,
    read,
    restorePendingWrites,
    enrichCommons,
    applyChangeDetail,
    pendingByRowId,
    pendingLedgerRows,
    pendingLedgerRowsForView,
    inflightBalance,
    dismissCommonsIntent,
    retryPendingWrite,
    editPendingWrite,
    cancelCommonsIntent,
    applyDenied,
    directory,
    personOf,
    displayName,
    shortName,
    setNav,
    applySearch,
    retrySearch,
    searchFor,
    clearSearch,
    openDetail,
    closeDetail,
    loadModalMembers,
    openAddExpense,
    openEditExpense,
    closeExpense,
    setExpense,
    setExpenseGroup,
    saveExpense,
    deleteExpense,
    undoExpense,
    restoreExpense,
    materializeRecurringExpense,
    editRecurringExpense,
    renameGroup,
    addGroupMember,
    removeGroupMember,
    deleteGroup,
    openSettle,
    closeSettle,
    setSettle,
    saveSettle,
    openNewGroup,
    closeNewGroup,
    setNewGroup,
    saveNewGroup,
    openAddFriend,
    closeAddFriend,
    setAddFriend,
    saveAddFriend,
    closeAllModals,
    anyModalOpen,
  };
}
