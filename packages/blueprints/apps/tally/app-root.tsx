// Tally — query-free React tree (issue #505). Holds the `Root` component and
// every constant, helper and type it needs that does NOT depend on the
// node-side `./queries/*` handler modules. The shell's InlineAppModule
// descriptor imports `Root` and `CHANGE_TABLES` from here and adds the query
// wiring; there is deliberately no parallel served-system-app entry.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { identityColor } from "@centraid/design";

import type { InlineAppProps } from "../inline-types.ts";
import { Chrome } from "./Chrome.tsx";
import type { ChromeAvatar } from "./Chrome.tsx";
import { ActivityFeed } from "./components/Activity.tsx";
import { Dashboard } from "./components/Dashboard.tsx";
import { DetailModal } from "./components/DetailModal.tsx";
import { ExpenseModal } from "./components/ExpenseModal.tsx";
import { ExpenseUndo } from "./components/ExpenseUndo.tsx";
import { FriendModal } from "./components/FriendModal.tsx";
import { GroupManager } from "./components/GroupManager.tsx";
import { GroupModal } from "./components/GroupModal.tsx";
import { Ledger } from "./components/Ledger.tsx";
import { SearchResults } from "./components/Search.tsx";
import { SettleModal } from "./components/SettleModal.tsx";
import { KitSkeleton } from "./components/Shared.tsx";
import { FriendsNav, GroupsNav, SmartNav } from "./components/Sidebar.tsx";
import { first, money } from "./format.ts";
import {
  observeWidth,
  onDataChange,
  onFocusRefresh,
  readFailed,
} from "./kit.ts";
import { createLogic, decorateLedgerRow } from "./logic.ts";
import { tallySearchGroups } from "./search-groups.ts";
import type {
  AppState,
  Dash,
  DashboardPayload,
  NavPatch,
  ViewData,
} from "./types.ts";

// Vault entities this app's queries read — the doorbell filter re-derives only
// when a change names one of these (or names none, i.e. "this app acted").
export const CHANGE_TABLES = [
  "tally.expense",
  "tally.expense_split",
  "tally.expense_receipt",
  "tally.expense_line_item",
  "tally.expense_line_allocation",
  "tally.recurring_expense",
  "schedule.recurrence_exception",
  "core.content_item",
  "tally.settlement",
  "tally.friend",
  "tally.group",
  "social.circle",
  "social.circle_member",
  "core.party",
  "core.vault",
  "tally",
];

function makeState(): AppState {
  return {
    view: "dashboard",
    groupId: null,
    friendId: null,
    search: "",
    searchStatus: "resting",
    narrow: false,
    viewData: null,
    detail: null,
    expense: null,
    settle: null,
    newGroup: null,
    addFriend: null,
    expenseUndo: null,
    modalMembers: [],
  };
}

function makeDash(): Dash {
  return {
    me: null,
    currency: "USD",
    friends: [],
    groups: [],
    trash: [],
    recurring: [],
    owe_total_minor: 0,
    owed_total_minor: 0,
  };
}

export function Root({ rootRef }: InlineAppProps): ReactNode {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [narrow, setNarrow] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);

  const rootElRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<AppState>(makeState());
  const dashRef = useRef<Dash>(makeDash());
  const logicRef = useRef<ReturnType<typeof createLogic> | null>(null);
  const viewSeqRef = useRef(0);
  const lastViewKeyRef = useRef("");
  const deniedRef = useRef<{ message: string } | null>(null);
  const dashReadyRef = useRef(false);

  // Fetch the payload for the active view, then re-render. Navigating to a NEW
  // view wipes to a skeleton immediately; re-fetching the SAME view keeps the
  // current rows painted until the fresh payload lands (issue #404). `viewSeq`
  // drops a stale fetch a newer navigation superseded.
  const loadView = useCallback(async () => {
    const state = stateRef.current;
    const dash = dashRef.current;
    const logic = logicRef.current!;
    const key = `${state.view}|${state.groupId}|${state.friendId}|${state.search.trim()}`;
    const seq = ++viewSeqRef.current;
    if (key !== lastViewKeyRef.current) {
      lastViewKeyRef.current = key;
      state.viewData = null;
    }
    bump(); // paint chrome + (on navigation) a skeleton immediately
    let next: ViewData | null = null;
    try {
      if (state.view === "group" && state.groupId) {
        next = await logic.read("group", { group_id: state.groupId });
      } else if (state.view === "friend" && state.friendId) {
        next = await logic.read("friend", { party_id: state.friendId });
      } else if (state.view === "activity") {
        next = await logic.read("activity");
      } else if (state.search.trim()) {
        next = await logic.read("search", { term: state.search.trim() });
      }
    } catch (error) {
      logic.notice(String((error as { message?: string })?.message ?? error));
    }
    if (seq !== viewSeqRef.current) return;
    state.viewData = next;
    if (state.viewData?.me) dash.me = state.viewData.me;
    if (state.viewData?.vaultDenied) {
      deniedRef.current = { message: state.viewData.vaultDenied.message ?? "" };
    }
    bump();
  }, []);

  // Re-fetch the sidebar/dashboard snapshot. Denial re-derives the consent
  // banner into React state (deniedRef) instead of logic.applyDenied's DOM
  // writes, which would target the shell's own `#root` here.
  const refreshDashboard = useCallback(async (): Promise<boolean> => {
    const dash = dashRef.current;
    const logic = logicRef.current!;
    let next: DashboardPayload | undefined;
    try {
      next = await logic.read<DashboardPayload>("dashboard");
    } catch {
      readFailed(document.querySelector<HTMLElement>("#noticeBanner"));
      return false;
    }
    dashReadyRef.current = true;
    if (next?.vaultDenied) {
      deniedRef.current = { message: next.vaultDenied.message ?? "" };
      return false;
    }
    deniedRef.current = null;
    const merged = next ?? dash;
    dash.currency = merged.currency;
    dash.friends = merged.friends ?? [];
    dash.groups = merged.groups ?? [];
    dash.trash = merged.trash ?? [];
    dash.recurring = merged.recurring ?? [];
    dash.owe_total_minor = merged.owe_total_minor;
    dash.owed_total_minor = merged.owed_total_minor;
    if (merged.me) dash.me = merged.me;
    return true;
  }, []);

  const refreshAll = useCallback(async () => {
    // The sidebar snapshot and the active detail view are independent reads —
    // run them together (issue #404); a final bump reconciles the tree.
    await Promise.all([refreshDashboard(), loadView()]);
    // Mount/refresh (issue #738): rebuild the model from the durable outbox
    // first — the ONLY source of truth for queued/sending/parked rows — then
    // fold in the online Commons rail as enrichment, never a rebuild.
    await logicRef.current?.restorePendingWrites();
    await logicRef.current?.enrichCommons();
    bump();
  }, [refreshDashboard, loadView]);

  if (!logicRef.current) {
    logicRef.current = createLogic({
      state: stateRef.current,
      dash: dashRef.current,
      render: bump,
      renderModals: bump,
      loadView: () => loadView(),
      refreshAll: () => refreshAll(),
    });
  }
  const logic = logicRef.current;
  const {
    closeAddFriend: handleCloseAddFriend,
    closeDetail: handleCloseDetail,
    closeExpense: handleCloseExpense,
    closeNewGroup: handleCloseNewGroup,
    closeSettle: handleCloseSettle,
    deleteExpense: handleDeleteExpense,
    deleteGroup: handleDeleteGroup,
    dismissCommonsIntent: handleDismissDeniedIntent,
    retryPendingWrite: handleRetryPendingWrite,
    editPendingWrite: handleEditPendingWrite,
    cancelCommonsIntent: handleCancelCommonsIntent,
    addGroupMember: handleAddGroupMember,
    openAddExpense: handleOpenAddExpense,
    openAddFriend: handleOpenAddFriend,
    openDetail: handleOpenDetail,
    openEditExpense: handleOpenEditExpense,
    openNewGroup: handleOpenNewGroup,
    openSettle: handleOpenSettle,
    restoreExpense: handleRestoreExpense,
    removeGroupMember: handleRemoveGroupMember,
    renameGroup: handleRenameGroup,
    saveAddFriend: handleSaveAddFriend,
    saveExpense: handleSaveExpense,
    saveNewGroup: handleSaveNewGroup,
    saveSettle: handleSaveSettle,
    setAddFriend: handleSetAddFriend,
    setExpense: handleSetExpense,
    setExpenseGroup: handleSetExpenseGroup,
    setNewGroup: handleSetNewGroup,
    setSettle: handleSetSettle,
    undoExpense: handleUndoExpense,
    materializeRecurringExpense: handleMaterializeRecurring,
    editRecurringExpense: handleEditRecurring,
  } = logic;

  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootElRef.current = el;
      rootRef(el);
    },
    [rootRef]
  );

  // A nav that also closes the narrow drawer (logic.setNav's own
  // `$('root').classList.remove('side-open')` targets the shell root inline, so
  // the drawer is closed here through React state instead).
  const navTo = useCallback((patch: NavPatch) => {
    setSideOpen(false);
    logicRef.current!.setNav(patch);
  }, []);

  // ---- chrome wiring: doorbell, focus refresh, keys, width ----
  useEffect(() => {
    const stopDoorbell = onDataChange(CHANGE_TABLES, async (detail) => {
      // Fold the overlay-source event into the pending model first — a full
      // refresh still follows, since only a real fetch replaces an executed
      // row's optimistic stand-in with canonical truth.
      logicRef.current?.applyChangeDetail(detail);
      await refreshAll();
      bump();
    });
    const stopFocus = onFocusRefresh(() => void refreshAll());
    const onKey = (e: globalThis.KeyboardEvent): void => {
      const l = logicRef.current!;
      const target = e.target;
      const editing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (e.key === "/" && !editing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        document.querySelector<HTMLInputElement>("#searchInput")?.focus();
        return;
      }
      if (
        e.key.toLowerCase() === "n" &&
        !editing &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !l.anyModalOpen()
      ) {
        e.preventDefault();
        void handleOpenAddExpense();
        return;
      }
      if (e.key !== "Escape") return;
      if (l.anyModalOpen()) {
        l.closeAllModals();
        bump();
        return;
      }
      setSideOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const stopWidth = rootElRef.current
      ? observeWidth(rootElRef.current, 900, (isNarrow: boolean) => {
          stateRef.current.narrow = isNarrow;
          setNarrow(isNarrow);
          if (!isNarrow) setSideOpen(false);
        })
      : () => {};
    void refreshAll();
    return () => {
      stopDoorbell();
      stopFocus();
      stopWidth();
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once wiring, stable deps via refs (#505)
  }, []);

  const state = stateRef.current;
  const dash = dashRef.current;

  // The dashboard hero totals with in-flight optimistic adds folded in (parked
  // rows excluded — a parked write hasn't moved any balance yet).
  const dashWithPending = (): Dash => {
    const { owe, owed } = logic.inflightBalance();
    if (!owe && !owed) return dash;
    return {
      ...dash,
      owe_total_minor: dash.owe_total_minor + owe,
      owed_total_minor: dash.owed_total_minor + owed,
    };
  };

  // ---- Topbar (mirrors app.tsx renderTopbar) ----
  const q = state.search.trim();
  let title: string;
  let sub: string;
  let avatar: ChromeAvatar | null = null;
  let showSettle = false;
  if (q) {
    title = `Results for “${q}”`;
    const n = state.viewData?.results?.length ?? 0;
    sub = `${n} match${n === 1 ? "" : "es"}`;
  } else if (state.view === "group" && state.viewData?.group) {
    const g = state.viewData.group;
    avatar = { bg: g.color || identityColor(g.name), text: g.icon || "👥" };
    title = g.name;
    const n = state.viewData.members?.length ?? 0;
    sub = `${n} member${n === 1 ? "" : "s"}`;
    showSettle = true;
  } else if (state.view === "friend" && state.viewData?.friend) {
    const f = state.viewData.friend;
    avatar = { bg: f.color || identityColor(f.party_id), text: f.initials };
    title = f.name;
    const v = f.net_minor;
    sub =
      Math.abs(v) < 1
        ? "You are settled up"
        : v > 0
          ? `${first(f.name)} owes you ${money(v, dash.currency)}`
          : `You owe ${first(f.name)} ${money(v, dash.currency)}`;
    showSettle = true;
  } else if (state.view === "activity") {
    title = "Activity";
    sub = "Expenses and settlements, newest first";
  } else {
    title = "Dashboard";
    sub = "Your balances at a glance";
  }

  // ---- Main content (mirrors app.tsx render) ----
  let content: ReactNode = null;
  if (q) {
    // Group/person rows above the expense list (issue #712 S1,
    // `search-groups.ts`) — matched client-side against the dashboard
    // snapshot already loaded, the same way Photos matches people/places/
    // albums against data it already holds rather than round-tripping for
    // them separately.
    const searchGroupRows = tallySearchGroups(q, {
      groups: dash.groups,
      friends: dash.friends,
    });
    content = (
      <SearchResults
        viewData={state.viewData}
        status={state.searchStatus}
        search={q}
        currency={dash.currency}
        groups={searchGroupRows}
        onOpenDetail={handleOpenDetail}
        onClearSearch={() => logic.clearSearch()}
        onRetry={() => logic.retrySearch()}
        onQuery={(value) => logic.searchFor(value)}
        onOpenGroup={(target, row) => {
          if (row.kind === "group") {
            navTo({ view: "group", groupId: target, search: "" });
          } else {
            navTo({ view: "friend", friendId: target, search: "" });
          }
        }}
      />
    );
  } else if (state.view === "dashboard") {
    content = dashReadyRef.current ? (
      <Dashboard
        dash={dashWithPending()}
        onOpenFriend={(friendId) =>
          navTo({ view: "friend", friendId, search: "" })
        }
        onOpenGroup={(groupId) => navTo({ view: "group", groupId, search: "" })}
        onOpenAddFriend={handleOpenAddFriend}
        onOpenNewGroup={handleOpenNewGroup}
        onRestoreExpense={handleRestoreExpense}
        onMaterializeRecurring={handleMaterializeRecurring}
        onEditRecurring={(template, scope, action, override) =>
          handleEditRecurring(
            template.template_id,
            template.next_start ?? new Date().toISOString(),
            scope,
            action,
            override
          )
        }
      />
    ) : (
      <KitSkeleton rows={4} />
    );
  } else if (state.view === "activity") {
    content = (
      <ActivityFeed
        viewData={state.viewData}
        me={dash.me}
        currency={dash.currency}
        onAddExpense={handleOpenAddExpense}
      />
    );
  } else if (state.view === "group" || state.view === "friend") {
    // Pending rows the query could not return render on top of the fetched
    // ledger, newest first — never mutating state.viewData, so a refresh
    // replaces it wholesale. The fetched rows themselves are decorated with
    // the pending chip fields (and the money the query could not derive from
    // unprojected splits) via the model's row-id index (issue #738).
    const pend = logic.pendingLedgerRowsForView();
    const byRowId = logic.pendingByRowId();
    const viewData: ViewData | null = state.viewData
      ? {
          ...state.viewData,
          ledger: [
            ...pend,
            ...(state.viewData.ledger ?? []).map((row) =>
              decorateLedgerRow(row, byRowId, dash.me)
            ),
          ],
        }
      : state.viewData;
    content = (
      <>
        {state.view === "group" && viewData?.group ? (
          <GroupManager
            key={viewData.group.group_id}
            group={viewData.group}
            members={viewData.members ?? []}
            friends={dash.friends}
            me={dash.me}
            onRename={handleRenameGroup}
            onAddMember={handleAddGroupMember}
            onRemoveMember={handleRemoveGroupMember}
            onDelete={handleDeleteGroup}
          />
        ) : null}
        <Ledger
          view={state.view}
          viewData={viewData}
          currency={dash.currency}
          onOpenDetail={handleOpenDetail}
          onAddExpense={handleOpenAddExpense}
          onDismissDenied={(row) =>
            row.commonsIntentId &&
            handleDismissDeniedIntent(row.commonsIntentId)
          }
          onRetryPending={(row) => {
            if (row.commonsIntentId)
              void handleRetryPendingWrite(row.commonsIntentId);
          }}
          onEditPending={(row) => {
            if (row.commonsIntentId)
              void handleEditPendingWrite(row.commonsIntentId);
          }}
          onCancelIntent={(row) =>
            row.commonsIntentId &&
            handleCancelCommonsIntent(row.commonsIntentId)
          }
        />
      </>
    );
  }

  if (state.expenseUndo) {
    content = (
      <>
        <ExpenseUndo undo={state.expenseUndo} onUndo={handleUndoExpense} />
        {content}
      </>
    );
  }

  // ---- Modal (mirrors app.tsx renderModals) ----
  let modal: ReactNode = null;
  if (state.detail) {
    modal = (
      <DetailModal
        row={state.detail}
        me={dash.me}
        groups={dash.groups}
        currency={dash.currency}
        onClose={handleCloseDetail}
        onEdit={handleOpenEditExpense}
        onDelete={handleDeleteExpense}
        onUndo={handleUndoExpense}
      />
    );
  } else if (state.expense) {
    modal = (
      <ExpenseModal
        exp={state.expense}
        members={state.modalMembers}
        groups={dash.groups}
        me={dash.me}
        currency={dash.currency}
        onPatch={handleSetExpense}
        onGroupChange={handleSetExpenseGroup}
        onClose={handleCloseExpense}
        onSave={handleSaveExpense}
        onDelete={handleDeleteExpense}
      />
    );
  } else if (state.settle) {
    modal = (
      <SettleModal
        st={state.settle}
        me={dash.me}
        currency={dash.currency}
        personOf={logic.personOf}
        onPatch={handleSetSettle}
        onClose={handleCloseSettle}
        onSave={handleSaveSettle}
      />
    );
  } else if (state.newGroup) {
    modal = (
      <GroupModal
        ng={state.newGroup}
        friends={dash.friends}
        onPatch={handleSetNewGroup}
        onClose={handleCloseNewGroup}
        onSave={handleSaveNewGroup}
      />
    );
  } else if (state.addFriend) {
    modal = (
      <FriendModal
        af={state.addFriend}
        onPatch={handleSetAddFriend}
        onClose={handleCloseAddFriend}
        onSave={handleSaveAddFriend}
      />
    );
  }

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    logic.clearSearch();
  };

  return (
    // Fill the app pane (a flex child of the route body) so the inline chrome
    // gets real width — otherwise it collapses to content width and the
    // component-width narrow observer wrongly flips to the phone drawer layout.
    <div
      ref={setRoot}
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <Chrome
        narrow={narrow}
        sideOpen={sideOpen}
        title={title}
        sub={sub}
        avatar={avatar}
        showSettle={showSettle}
        consent={deniedRef.current}
        onOpenSide={() => setSideOpen(true)}
        onCloseSide={() => setSideOpen(false)}
        onAddExpense={handleOpenAddExpense}
        onNewGroup={handleOpenNewGroup}
        onAddFriend={handleOpenAddFriend}
        onSettle={handleOpenSettle}
        onSearchInput={() => logic.applySearch()}
        onSearchKeyDown={onSearchKeyDown}
        smartNav={<SmartNav view={state.view} onSelect={navTo} />}
        groupsNav={
          <GroupsNav
            groups={dash.groups}
            view={state.view}
            groupId={state.groupId}
            currency={dash.currency}
            onSelect={navTo}
          />
        }
        friendsNav={
          <FriendsNav
            friends={dash.friends}
            view={state.view}
            friendId={state.friendId}
            currency={dash.currency}
            onSelect={navTo}
          />
        }
        content={content}
        modal={modal}
      />
    </div>
  );
}
