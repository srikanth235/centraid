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
  convertMinor,
  first,
  rateToScaled,
  resolveSplits,
  toCents,
  todayKey,
} from "./format.ts";
import { debounce, outcomeMessage, statusLine } from "./kit.ts";
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

export function createLogic({
  state,
  dash,
  render,
  renderModals,
  loadView,
  refreshAll,
}: LogicDeps) {
  const $ = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;

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

  async function act(
    action: string,
    input: Record<string, unknown>,
    intentId?: string
  ): Promise<VaultOutcome | undefined> {
    try {
      return await window.centraid.write({
        action,
        input,
        ...(intentId ? { intentId } : {}),
      });
    } catch (error) {
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

  // Build the decorated row shape the group/friend ledger queries return, so
  // an optimistic add renders through the exact same components (ExpenseRow)
  // as a fetched row — plus `pending`/`parked` flags for the kit chip.
  function pendingExpenseRow(
    groupId: string,
    base: ExpenseBase,
    expenseId: string
  ): LedgerRow {
    const myShare =
      base.splits.find((s) => s.party_id === dash.me)?.share_minor ?? 0;
    let your_role: Role = "none";
    let your_amount_minor = 0;
    if (base.paid_by === dash.me) {
      your_role = "lent";
      your_amount_minor = base.amount_minor - myShare;
    } else if (myShare > 0) {
      your_role = "borrowed";
      your_amount_minor = myShare;
    }
    return {
      expense_id: expenseId,
      group_id: groupId,
      group_name: dash.groups.find((g) => g.group_id === groupId)?.name ?? "",
      description: base.description,
      amount_minor: base.amount_minor,
      paid_by: base.paid_by,
      paid_by_name: displayName(base.paid_by),
      category: base.category,
      spent_on: base.spent_on,
      splits: base.splits.map((s) => ({ ...s })),
      your_role,
      your_amount_minor,
      pending: true,
      parked: false,
    };
  }

  function optimisticExpenseRow(
    exp: ExpenseModel,
    base: ExpenseBase
  ): LedgerRow {
    return pendingExpenseRow(
      exp.groupId,
      base,
      `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    );
  }

  /**
   * Rebuild Tally's flagship optimistic overlay from vault-resident Commons
   * intents. A reload therefore does not erase a member's expense merely
   * because the steward is offline; executed commands disappear once server
   * truth is queryable, while parked and denied rows keep their reason.
   */
  async function refreshCommonsExpenses(): Promise<void> {
    if (!window.centraid.commonsIntents) return;
    let intents: CentraidCommonsIntent[];
    try {
      intents = await window.centraid.commonsIntents();
    } catch {
      return;
    }
    const durable: LedgerRow[] = [];
    for (const intent of intents) {
      // `LedgerRow["intentStatus"]` has no "executed" member — an executed
      // intent never becomes a row — so the wire status is narrowed once
      // here and the "executed" case is checked on `intent` itself below.
      const status = intent.status as LedgerRow["intentStatus"];
      // A settled-but-not-executed intent the member already dismissed
      // stays gone across refreshes (issue #731 m6, extended by goal 2) —
      // pending/parked rows are never in this set, so they keep
      // re-appearing exactly as before.
      const dismissibleSettled =
        status === "denied" || status === "expired" || status === "cancelled";
      if (
        intent.command !== "tally.add_expense" ||
        intent.status === "executed" ||
        (dismissibleSettled &&
          state.dismissedCommonsIntentIds.has(intent.intentId))
      )
        continue;
      const raw = intent.input;
      const groupId = typeof raw.group_id === "string" ? raw.group_id : "";
      const description =
        typeof raw.description === "string" ? raw.description : "";
      const paidBy = typeof raw.paid_by === "string" ? raw.paid_by : "";
      const amountMinor = Number(raw.amount_minor);
      if (!groupId || !description || !paidBy || !Number.isFinite(amountMinor))
        continue;
      const splits = Array.isArray(raw.splits)
        ? raw.splits.flatMap((entry): SplitEntry[] => {
            if (!entry || typeof entry !== "object") return [];
            const split = entry as Record<string, unknown>;
            const partyId =
              typeof split.party_id === "string" ? split.party_id : "";
            const shareMinor = Number(split.share_minor);
            return partyId && Number.isFinite(shareMinor)
              ? [{ party_id: partyId, share_minor: shareMinor }]
              : [];
          })
        : [];
      const row = pendingExpenseRow(
        groupId,
        {
          description,
          amount_minor: amountMinor,
          paid_by: paidBy,
          category: typeof raw.category === "string" ? raw.category : "general",
          spent_on:
            typeof raw.spent_on === "string"
              ? raw.spent_on
              : new Date(intent.createdAt).toISOString().slice(0, 10),
          splits,
        },
        `commons-${intent.intentId}`
      );
      row.commonsIntentId = intent.intentId;
      row.intentStatus = status;
      row.parked = true;
      row.pendingReason = intent.reason;
      row.stewardLabel = intent.stewardLabel;
      durable.push(row);
    }
    state.pendingExpenses = durable;
  }

  /**
   * Settle a settled-but-not-executed (`denied`/`expired`/`cancelled`)
   * durable Commons intent out of the ledger overlay for good (issue #731
   * m6, extended by goal 2) — a no-op for anything else, so a pending/parked
   * row (still genuinely in flight) can never be dismissed away. Removes it
   * from `state.pendingExpenses` immediately (no round trip to wait on) and
   * remembers the id so the next `refreshCommonsExpenses` doesn't resurrect it.
   */
  function dismissCommonsIntent(intentId: string) {
    const row = state.pendingExpenses.find(
      (r) => r.commonsIntentId === intentId
    );
    if (
      !row ||
      (row.intentStatus !== "denied" &&
        row.intentStatus !== "expired" &&
        row.intentStatus !== "cancelled")
    )
      return;
    state.dismissedCommonsIntentIds.add(intentId);
    state.pendingExpenses = state.pendingExpenses.filter(
      (r) => r.commonsIntentId !== intentId
    );
    render();
  }

  /**
   * Cancel a durable Commons intent that has not executed yet (issue #731
   * goal 2) — meaningful only while it is still `pending`/`parked`; a no-op
   * otherwise. A genuine race with the steward (or the peer sweep retrying a
   * parked intent) is possible, so this never assumes the cancel won: it
   * re-syncs from `commonsIntents()` afterward and lets the row show
   * whatever actually settled — `cancelled`, or the steward's real answer if
   * the race was lost.
   */
  async function cancelCommonsIntent(intentId: string) {
    const row = state.pendingExpenses.find(
      (r) => r.commonsIntentId === intentId
    );
    if (
      !row ||
      (row.intentStatus !== "pending" && row.intentStatus !== "parked")
    )
      return;
    const cancel = window.centraid.cancelCommonsIntent;
    if (!cancel) return;
    try {
      await cancel({ intentId });
    } catch {
      // A transport failure leaves the row exactly as it was; the refresh
      // below (or the member's next action) reconciles it either way.
    }
    await refreshCommonsExpenses();
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
    // Optimistic add — the hot path (issue #404). The row lands in local
    // state and the modal closes BEFORE the write resolves, so the click
    // costs zero round trips; the write itself then reconciles:
    //   executed → the write's own change doorbell (onDataChange in app.tsx)
    //              refetches and swaps the optimistic row for server truth;
    //   parked   → the row stays, chip and all, exactly like tasks' parked
    //              ghost adds, until some later change resolves it;
    //   failed/denied/threw → the row is removed and the notice banner
    //              carries the existing plain-language reason.
    const intentId = globalThis.crypto.randomUUID();
    const row = optimisticExpenseRow(exp, base);
    row.commonsIntentId = intentId;
    state.pendingExpenses.push(row);
    closeExpense();
    render();
    const outcome = await act(
      "add-expense",
      {
        group_id: exp.groupId,
        ...base,
        ...currencyFields,
      },
      intentId
    );
    if (outcome?.status === "executed") {
      notice("");
      statusLine("Expense added · receipted.");
      return;
    }
    if (outcome?.status === "parked") {
      row.parked = true;
      row.intentStatus = "parked";
      row.pendingReason = outcome.reason ?? outcome.message;
      narrate(outcome); // the existing parked banner copy
      render();
      return;
    }
    await refreshCommonsExpenses();
    if (
      state.pendingExpenses.some(
        (pending) => pending.commonsIntentId === intentId
      )
    ) {
      if (outcome) narrate(outcome);
      render();
      return;
    }
    const i = state.pendingExpenses.indexOf(row);
    if (i >= 0) state.pendingExpenses.splice(i, 1);
    if (outcome) narrate(outcome); // a thrown transport error already hit the banner via act()
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
    refreshCommonsExpenses,
    dismissCommonsIntent,
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
