// governance: allow-repo-hygiene file-size-limit blueprints are single-file by design (read wholesale by one agent); Tally is a finished expense splitter — sidebar, dashboard, group/friend ledgers, activity, add/edit/settle/new-group/add-friend modals — and splitting it would break that "one file" contract.
// Tally — split, settled, as a projection over the personal vault. A friend is
// a canonical core.party; a group is a tally.group with one member row per
// party (you included); an expense stores its resolved splits. Balances are
// NEVER stored — they are derived server-side by the balance engine and this
// client just fetches + renders them. All money crosses the wire as INTEGER
// minor units (cents); the app formats it and, on the way out, resolves the
// chosen split mode (equally / exact / percent) into an integer splits array.
// Every write is a typed vault command — consent-checked and receipted. The
// app stores nothing of its own: revoke the grant and this page goes dark.
//
// React port: module-level `state`/`dash` (mutated in place, never
// reassigned) plus a `render()` orchestrator fanning out to one React root
// per stable container — the same tasks/notes/app.jsx pattern. `logic.js`
// holds the non-visual business logic (vault IO, the people directory, every
// modal's open/patch/save/close flow); `chrome.js` wires the toolbar/
// keyboard/resize listeners; `format.js`/`icons.js` are stateless.
// `components/` holds pure functions of props. `dash.me` folds in what the
// old app.js kept as a separate module-level `let me` — same "only overwrite
// when the read actually carries one" guard, just living on the object that
// closures already share instead of a second free variable.
import { createRoot } from './react-core.min.js';
import { onDataChange, readFailed, showSkeleton } from './kit.js';
import { createLogic } from './logic.js';
import { wireChrome } from './chrome.js';
import { first, money } from './format.js';
import { FriendsNav, GroupsNav, SmartNav } from './components/Sidebar.jsx';
import { Dashboard } from './components/Dashboard.jsx';
import { Ledger } from './components/Ledger.jsx';
import { SearchResults } from './components/Search.jsx';
import { ActivityFeed } from './components/Activity.jsx';
import { DetailModal } from './components/DetailModal.jsx';
import { ExpenseModal } from './components/ExpenseModal.jsx';
import { SettleModal } from './components/SettleModal.jsx';
import { GroupModal } from './components/GroupModal.jsx';
import { FriendModal } from './components/FriendModal.jsx';

const $ = (id) => document.getElementById(id);

// Vault entities this app's queries read — the doorbell filter re-derives
// only when a change names one of these (or names none, i.e. "this app acted").
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
];

// ---------- State ----------
// The sidebar/dashboard snapshot (dashboard query) plus `me` — never
// reassigned, only its fields are mutated, so logic.js's closure over it
// stays valid — and all client-side presentation state, which is never
// persisted and never sent to the vault.

const dash = {
  me: null,
  currency: 'USD',
  friends: [],
  groups: [],
  owe_total_minor: 0,
  owed_total_minor: 0,
};

const state = {
  view: 'dashboard', // dashboard | activity | group | friend
  groupId: null,
  friendId: null,
  search: '',
  narrow: false,
  // The currently-loaded detail payload for the active view (group/friend/activity/search).
  viewData: null,
  // Open surfaces.
  detail: null, // a ledger row
  expense: null, // add/edit form model
  settle: null,
  newGroup: null,
  addFriend: null,
  // Members of the group chosen in the expense/settle modal (fetched on demand).
  modalMembers: [],
};

// ---------- Logic instance ----------
// `render`/`renderModals`/`loadView`/`refreshAll` are `function` declarations
// (hoisted), so `logic` can close over them here even though they're defined
// further down the file — same trick tasks/app.jsx's `createLogic(...)` call
// relies on.

const logic = createLogic({ state, dash, render, renderModals, loadView, refreshAll });

let setThemeIcon;

// ---------- Roots ----------

let smartNavRoot;
let groupsNavRoot;
let friendsNavRoot;
let wrapRoot;
let modalRoot;

// ---------- Sidebar / topbar ----------

function renderSidebar() {
  smartNavRoot.render(<SmartNav view={state.view} onSelect={logic.setNav} />);
  groupsNavRoot.render(
    <GroupsNav
      groups={dash.groups}
      view={state.view}
      groupId={state.groupId}
      currency={dash.currency}
      onSelect={logic.setNav}
    />,
  );
  friendsNavRoot.render(
    <FriendsNav
      friends={dash.friends}
      view={state.view}
      friendId={state.friendId}
      currency={dash.currency}
      onSelect={logic.setNav}
    />,
  );
}

function renderTopbar() {
  const av = $('headAv');
  const title = $('activeTitle');
  const sub = $('activeSub');
  const settleBtn = $('settleBtn');
  av.hidden = true;
  settleBtn.hidden = true;

  if (state.search.trim()) {
    title.textContent = `Results for “${state.search.trim()}”`;
    const n = state.viewData?.results?.length ?? 0;
    sub.textContent = `${n} match${n === 1 ? '' : 'es'}`;
    return;
  }
  if (state.view === 'group' && state.viewData?.group) {
    const g = state.viewData.group;
    av.hidden = false;
    av.style.background = g.color || '#0FA678';
    av.textContent = g.icon || '👥';
    title.textContent = g.name;
    const n = state.viewData.members?.length ?? 0;
    sub.textContent = `${n} member${n === 1 ? '' : 's'}`;
    settleBtn.hidden = false;
    return;
  }
  if (state.view === 'friend' && state.viewData?.friend) {
    const f = state.viewData.friend;
    av.hidden = false;
    av.style.background = f.color || '#5C677D';
    av.textContent = f.initials;
    title.textContent = f.name;
    const v = f.net_minor;
    sub.textContent =
      Math.abs(v) < 1
        ? 'You are settled up'
        : v > 0
          ? `${first(f.name)} owes you ${money(v, dash.currency)}`
          : `You owe ${first(f.name)} ${money(v, dash.currency)}`;
    settleBtn.hidden = false;
    return;
  }
  if (state.view === 'activity') {
    title.textContent = 'Activity';
    sub.textContent = 'Expenses and settlements, newest first';
    return;
  }
  title.textContent = 'Dashboard';
  sub.textContent = 'Your balances at a glance';
}

// ---------- Main content ----------

function render() {
  renderSidebar();
  renderTopbar();
  setThemeIcon?.();

  if (state.search.trim()) {
    wrapRoot.render(
      <SearchResults
        viewData={state.viewData}
        search={state.search.trim()}
        currency={dash.currency}
        onOpenDetail={logic.openDetail}
      />,
    );
    return;
  }
  if (state.view === 'dashboard') {
    wrapRoot.render(
      <Dashboard
        dash={dash}
        onOpenFriend={(friendId) => logic.setNav({ view: 'friend', friendId, search: '' })}
        onOpenGroup={(groupId) => logic.setNav({ view: 'group', groupId, search: '' })}
        onOpenAddFriend={logic.openAddFriend}
        onOpenNewGroup={logic.openNewGroup}
      />,
    );
    return;
  }
  if (state.view === 'activity') {
    wrapRoot.render(
      <ActivityFeed viewData={state.viewData} me={dash.me} currency={dash.currency} />,
    );
    return;
  }
  if (state.view === 'group' || state.view === 'friend') {
    wrapRoot.render(
      <Ledger
        view={state.view}
        viewData={state.viewData}
        currency={dash.currency}
        onOpenDetail={logic.openDetail}
      />,
    );
  }
}

// ---------- Modal shell ----------

function renderModals() {
  if (state.detail) {
    modalRoot.render(
      <DetailModal
        row={state.detail}
        me={dash.me}
        groups={dash.groups}
        currency={dash.currency}
        onClose={logic.closeDetail}
        onEdit={logic.openEditExpense}
        onDelete={logic.deleteExpense}
      />,
    );
  } else if (state.expense) {
    modalRoot.render(
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
      />,
    );
  } else if (state.settle) {
    modalRoot.render(
      <SettleModal
        st={state.settle}
        me={dash.me}
        currency={dash.currency}
        personOf={logic.personOf}
        onPatch={logic.setSettle}
        onClose={logic.closeSettle}
        onSave={logic.saveSettle}
      />,
    );
  } else if (state.newGroup) {
    modalRoot.render(
      <GroupModal
        ng={state.newGroup}
        friends={dash.friends}
        onPatch={logic.setNewGroup}
        onClose={logic.closeNewGroup}
        onSave={logic.saveNewGroup}
      />,
    );
  } else if (state.addFriend) {
    modalRoot.render(
      <FriendModal
        af={state.addFriend}
        onPatch={logic.setAddFriend}
        onClose={logic.closeAddFriend}
        onSave={logic.saveAddFriend}
      />,
    );
  } else {
    modalRoot.render(null);
  }
}

// ---------- View loading ----------

// Fetch the payload for the active view, then render.
async function loadView() {
  state.viewData = null;
  render(); // paint chrome + a skeleton immediately
  try {
    if (state.view === 'group' && state.groupId) {
      state.viewData = await logic.read('group', { group_id: state.groupId });
    } else if (state.view === 'friend' && state.friendId) {
      state.viewData = await logic.read('friend', { party_id: state.friendId });
    } else if (state.view === 'activity') {
      state.viewData = await logic.read('activity');
    } else if (state.search.trim()) {
      state.viewData = await logic.read('search', { term: state.search.trim() });
    }
  } catch (err) {
    logic.notice(String(err?.message ?? err));
  }
  if (state.viewData?.me) dash.me = state.viewData.me;
  if (state.viewData?.vaultDenied) return logic.applyDenied(state.viewData.vaultDenied);
  render();
}

// ---------- Refresh ----------

// Re-fetch the sidebar/dashboard snapshot, then reload the active detail view.
async function refreshDashboard() {
  let next;
  try {
    next = await logic.read('dashboard');
  } catch {
    readFailed($('noticeBanner'));
    return false;
  }
  if (next?.vaultDenied) {
    logic.applyDenied(next.vaultDenied);
    return false;
  }
  $('consentBanner').hidden = true;
  $('root').classList.remove('denied');
  const merged = next ?? dash;
  dash.currency = merged.currency;
  dash.friends = merged.friends ?? [];
  dash.groups = merged.groups ?? [];
  dash.owe_total_minor = merged.owe_total_minor;
  dash.owed_total_minor = merged.owed_total_minor;
  if (merged.me) dash.me = merged.me;
  return true;
}

async function refreshAll() {
  // The sidebar snapshot and the active detail view are independent reads —
  // run them together (issue #404) instead of dashboard-then-view serially.
  // A final render reconciles the sidebar regardless of which resolved first.
  await Promise.all([refreshDashboard(), loadView()]);
  render();
}

// ---------- Boot ----------

smartNavRoot = createRoot($('smartNav'));
groupsNavRoot = createRoot($('groupsNav'));
friendsNavRoot = createRoot($('friendsNav'));
wrapRoot = createRoot($('wrap'));
modalRoot = createRoot($('modalRoot'));

showSkeleton($('wrap'), 4);

({ setThemeIcon } = wireChrome({ state, logic, renderModals, refreshAll }));

// Reactive data: a write elsewhere (chat agent, a second window) fires the
// doorbell — re-derive. Debounced + tables-filtered by the kit helper.
onDataChange(CHANGE_TABLES, refreshAll);

refreshAll();
