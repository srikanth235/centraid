// governance: allow-repo-hygiene file-size-limit — inline sibling re-expresses the served entry's whole orchestration as one React tree by design (#505); splitting it belongs to the app's own code evolution, not this migration.
// Tally, inline (issue #505). The served entry (app.tsx) stays byte-for-byte for
// mobile WebViews + the visual harness; this co-located sibling re-expresses the
// SAME orchestration as ONE React tree for the shell's inline route. `logic.ts`
// (vault IO, the people directory, navigation, every modal's open/patch/save/
// close flow, the optimistic-add reconcile) and the `components/*` are reused
// verbatim; `chrome.ts`'s imperative listeners become hooks + JSX handlers;
// app.tsx's five `createRoot` islands and its render/renderModals/loadView/
// refreshAll orchestration collapse into this component's bump-driven tree.
// Reads/writes flow through the shell-installed `window.centraid` (backed by the
// replica), so mount awaits nothing over the network — first paint is local.
//
// One structural note vs the Tasks pilot: tally's served logic.ts drives the
// consent + narrow-drawer state through `document.getElementById('root')` — but
// the SHELL owns `<main id="root">`, so those verbatim `$('root')` classList
// calls resolve to the shell's element and are harmless no-ops here. This file
// therefore does NOT route denial through logic.applyDenied (it re-derives the
// consent banner from the read payload into React state) and closes the narrow
// drawer through React `sideOpen` rather than the `.side-open` class. Only the
// notice banner (`#noticeBanner`) and the search input (`#searchInput`) keep
// their ids, because logic.ts's notice()/applySearch()/clearSearch() address
// those two nodes by id — they are rendered once in Chrome for that reason.
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from './react-core.min.js';
import { observeWidth, onDataChange, onFocusRefresh, readFailed, wireThemeToggle } from './kit.js';
import { createLogic } from './logic.ts';
import { first, money } from './format.ts';
import { FriendsNav, GroupsNav, SmartNav } from './components/Sidebar.tsx';
import { Dashboard } from './components/Dashboard.tsx';
import { Ledger } from './components/Ledger.tsx';
import { SearchResults } from './components/Search.tsx';
import { ActivityFeed } from './components/Activity.tsx';
import { KitSkeleton } from './components/Shared.tsx';
import { DetailModal } from './components/DetailModal.tsx';
import { ExpenseModal } from './components/ExpenseModal.tsx';
import { SettleModal } from './components/SettleModal.tsx';
import { GroupModal } from './components/GroupModal.tsx';
import { FriendModal } from './components/FriendModal.tsx';
import { Chrome, type ChromeAvatar } from './Chrome.tsx';
import dashboardQuery from './queries/dashboard.ts';
import groupQuery from './queries/group.ts';
import friendQuery from './queries/friend.ts';
import activityQuery from './queries/activity.ts';
import searchQuery from './queries/search.ts';
import type { AppState, Dash, DashboardPayload, LedgerRow, NavPatch, ViewData } from './types.ts';
import type { InlineAppModule, InlineAppProps } from '../inline-types.ts';

// Vault entities this app's queries read — the doorbell filter re-derives only
// when a change names one of these (or names none, i.e. "this app acted").
const CHANGE_TABLES = [
  'tally.expense',
  'tally.expense_split',
  'tally.settlement',
  'tally.friend',
  'tally.group',
  'social.circle',
  'social.circle_member',
  'core.party',
  'core.vault',
  'tally',
];

function makeState(): AppState {
  return {
    view: 'dashboard',
    groupId: null,
    friendId: null,
    search: '',
    narrow: false,
    viewData: null,
    detail: null,
    expense: null,
    settle: null,
    newGroup: null,
    addFriend: null,
    modalMembers: [],
    pendingExpenses: [],
  };
}

function makeDash(): Dash {
  return {
    me: null,
    currency: 'USD',
    friends: [],
    groups: [],
    trash: [],
    owe_total_minor: 0,
    owed_total_minor: 0,
  };
}

function Root({ rootRef }: InlineAppProps): ReactNode {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [narrow, setNarrow] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);

  const rootElRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<AppState>(makeState());
  const dashRef = useRef<Dash>(makeDash());
  const logicRef = useRef<ReturnType<typeof createLogic> | null>(null);
  const themeBtnRef = useRef<HTMLButtonElement | null>(null);
  const viewSeqRef = useRef(0);
  const lastViewKeyRef = useRef('');
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
      if (state.view === 'group' && state.groupId) {
        next = await logic.read('group', { group_id: state.groupId });
      } else if (state.view === 'friend' && state.friendId) {
        next = await logic.read('friend', { party_id: state.friendId });
      } else if (state.view === 'activity') {
        next = await logic.read('activity');
      } else if (state.search.trim()) {
        next = await logic.read('search', { term: state.search.trim() });
      }
    } catch (err) {
      logic.notice(String((err as { message?: string })?.message ?? err));
    }
    if (seq !== viewSeqRef.current) return;
    state.viewData = next;
    if (state.viewData?.me) dash.me = state.viewData.me;
    if (state.viewData?.vaultDenied) {
      deniedRef.current = { message: state.viewData.vaultDenied.message ?? '' };
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
      next = await logic.read<DashboardPayload>('dashboard');
    } catch {
      readFailed(document.getElementById('noticeBanner'));
      return false;
    }
    dashReadyRef.current = true;
    if (next?.vaultDenied) {
      deniedRef.current = { message: next.vaultDenied.message ?? '' };
      return false;
    }
    deniedRef.current = null;
    const merged = next ?? dash;
    dash.currency = merged.currency;
    dash.friends = merged.friends ?? [];
    dash.groups = merged.groups ?? [];
    dash.trash = merged.trash ?? [];
    dash.owe_total_minor = merged.owe_total_minor;
    dash.owed_total_minor = merged.owed_total_minor;
    if (merged.me) dash.me = merged.me;
    return true;
  }, []);

  const refreshAll = useCallback(async () => {
    // The sidebar snapshot and the active detail view are independent reads —
    // run them together (issue #404); a final bump reconciles the tree.
    await Promise.all([refreshDashboard(), loadView()]);
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

  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootElRef.current = el;
      rootRef(el);
    },
    [rootRef],
  );

  // A nav that also closes the narrow drawer (logic.setNav's own
  // `$('root').classList.remove('side-open')` targets the shell root inline, so
  // the drawer is closed here through React state instead).
  const navTo = useCallback((patch: NavPatch) => {
    setSideOpen(false);
    logicRef.current!.setNav(patch);
  }, []);

  // ---- chrome wiring: theme toggle, doorbell, focus refresh, keys, width ----
  useEffect(() => {
    if (themeBtnRef.current) wireThemeToggle(themeBtnRef.current);
    const stopDoorbell = onDataChange(CHANGE_TABLES, async () => {
      await refreshAll();
      stateRef.current.pendingExpenses = [];
      bump();
    });
    const stopFocus = onFocusRefresh(() => void refreshAll());
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      const l = logicRef.current!;
      if (l.anyModalOpen()) {
        l.closeAllModals();
        bump();
        return;
      }
      setSideOpen(false);
    };
    window.addEventListener('keydown', onKey);
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
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once wiring, stable deps via refs (#505)
  }, []);

  const state = stateRef.current;
  const dash = dashRef.current;

  // The optimistic rows that belong on the currently visible ledger.
  const pendingForView = (): LedgerRow[] => {
    if (!state.pendingExpenses.length) return [];
    if (state.view === 'group')
      return state.pendingExpenses.filter((r) => r.group_id === state.groupId);
    if (state.view === 'friend')
      return state.pendingExpenses.filter(
        (r) =>
          r.paid_by === state.friendId ||
          (r.splits ?? []).some((s) => s.party_id === state.friendId),
      );
    return [];
  };

  // The dashboard hero totals with in-flight optimistic adds folded in (parked
  // rows excluded — a parked write hasn't moved any balance yet).
  const dashWithPending = (): Dash => {
    const inflight = state.pendingExpenses.filter((r) => !r.parked);
    if (!inflight.length) return dash;
    let owe = dash.owe_total_minor;
    let owed = dash.owed_total_minor;
    for (const r of inflight) {
      if (r.your_role === 'lent') owed += r.your_amount_minor;
      else if (r.your_role === 'borrowed') owe += r.your_amount_minor;
    }
    return { ...dash, owe_total_minor: owe, owed_total_minor: owed };
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
    sub = `${n} match${n === 1 ? '' : 'es'}`;
  } else if (state.view === 'group' && state.viewData?.group) {
    const g = state.viewData.group;
    avatar = { bg: g.color || '#0FA678', text: g.icon || '👥' };
    title = g.name;
    const n = state.viewData.members?.length ?? 0;
    sub = `${n} member${n === 1 ? '' : 's'}`;
    showSettle = true;
  } else if (state.view === 'friend' && state.viewData?.friend) {
    const f = state.viewData.friend;
    avatar = { bg: f.color || '#5C677D', text: f.initials };
    title = f.name;
    const v = f.net_minor;
    sub =
      Math.abs(v) < 1
        ? 'You are settled up'
        : v > 0
          ? `${first(f.name)} owes you ${money(v, dash.currency)}`
          : `You owe ${first(f.name)} ${money(v, dash.currency)}`;
    showSettle = true;
  } else if (state.view === 'activity') {
    title = 'Activity';
    sub = 'Expenses and settlements, newest first';
  } else {
    title = 'Dashboard';
    sub = 'Your balances at a glance';
  }

  // ---- Main content (mirrors app.tsx render) ----
  let content: ReactNode = null;
  if (q) {
    content = (
      <SearchResults
        viewData={state.viewData}
        search={q}
        currency={dash.currency}
        onOpenDetail={logic.openDetail}
      />
    );
  } else if (state.view === 'dashboard') {
    content = !dashReadyRef.current ? (
      <KitSkeleton rows={4} />
    ) : (
      <Dashboard
        dash={dashWithPending()}
        onOpenFriend={(friendId) => navTo({ view: 'friend', friendId, search: '' })}
        onOpenGroup={(groupId) => navTo({ view: 'group', groupId, search: '' })}
        onOpenAddFriend={logic.openAddFriend}
        onOpenNewGroup={logic.openNewGroup}
        onRestoreExpense={logic.restoreExpense}
      />
    );
  } else if (state.view === 'activity') {
    content = <ActivityFeed viewData={state.viewData} me={dash.me} currency={dash.currency} />;
  } else if (state.view === 'group' || state.view === 'friend') {
    // Optimistic adds render on top of the fetched ledger, newest first —
    // never mutating state.viewData, so a refresh replaces it wholesale.
    const pend = pendingForView();
    const viewData: ViewData | null =
      pend.length && state.viewData
        ? { ...state.viewData, ledger: [...pend, ...(state.viewData.ledger ?? [])] }
        : state.viewData;
    content = (
      <Ledger
        view={state.view}
        viewData={viewData}
        currency={dash.currency}
        onOpenDetail={logic.openDetail}
      />
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
        onClose={logic.closeDetail}
        onEdit={logic.openEditExpense}
        onDelete={logic.deleteExpense}
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
        onPatch={logic.setExpense}
        onGroupChange={logic.setExpenseGroup}
        onClose={logic.closeExpense}
        onSave={logic.saveExpense}
        onDelete={logic.deleteExpense}
      />
    );
  } else if (state.settle) {
    modal = (
      <SettleModal
        st={state.settle}
        me={dash.me}
        currency={dash.currency}
        personOf={logic.personOf}
        onPatch={logic.setSettle}
        onClose={logic.closeSettle}
        onSave={logic.saveSettle}
      />
    );
  } else if (state.newGroup) {
    modal = (
      <GroupModal
        ng={state.newGroup}
        friends={dash.friends}
        onPatch={logic.setNewGroup}
        onClose={logic.closeNewGroup}
        onSave={logic.saveNewGroup}
      />
    );
  } else if (state.addFriend) {
    modal = (
      <FriendModal
        af={state.addFriend}
        onPatch={logic.setAddFriend}
        onClose={logic.closeAddFriend}
        onSave={logic.saveAddFriend}
      />
    );
  }

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    logic.clearSearch();
  };

  return (
    // Fill the app pane (a flex child of the route body) so the inline chrome
    // gets real width — otherwise it collapses to content width and the
    // component-width narrow observer wrongly flips to the phone drawer layout.
    <div
      ref={setRoot}
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}
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
        onAddExpense={logic.openAddExpense}
        onNewGroup={logic.openNewGroup}
        onAddFriend={logic.openAddFriend}
        onSettle={logic.openSettle}
        onSearchInput={() => logic.applySearch()}
        onSearchKeyDown={onSearchKeyDown}
        themeButtonRef={(el) => {
          themeBtnRef.current = el;
        }}
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

const tallyInlineApp: InlineAppModule = {
  appId: 'tally',
  changeTables: CHANGE_TABLES,
  // The query defaults are typed against the ambient `HandlerArgs`; the inline
  // contract types `ctx` as `unknown`, so bridge the two here (the shell builds
  // a compatible ctx at run time — inlineQueryCtx.ts).
  queries: {
    dashboard: { default: dashboardQuery },
    group: { default: groupQuery },
    friend: { default: friendQuery },
    activity: { default: activityQuery },
    search: { default: searchQuery },
  } as unknown as InlineAppModule['queries'],
  kitAsk: {
    scope: 'tally',
    placeholder: 'Ask about your expenses…',
    intro:
      'Ask me to add an expense, settle up, or see who owes whom. Writes show for your approval before they touch the vault.',
    suggest: ['Split dinner four ways', 'Who do I owe?', 'Settle up with Alex'],
  },
  Root,
};

export default tallyInlineApp;
