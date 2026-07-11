// governance: allow-repo-hygiene file-size-limit (#363) blueprint apps ship a single app.jsx entry per the kit's convention (see sibling docs/photos/tally); splitting would break the served-as-one-module contract static-server.ts assumes
// People — your circle, remembered. A pure projection over the personal
// vault. Every row is a core.party; circles are collections, cadence and
// stars are judgments the vault holds, notes/tasks/gifts/debts/dates hang
// off the party, and interactions are the touch log. The app stores nothing
// of its own: revoke the grant and this page goes dark while the people,
// their history and the receipts remain the owner's. Every write is a typed
// vault command — consent-checked and receipted.
//
// The design + copy + interactions come from the People prototype; the data
// is real, so where the prototype seeded contacts a fresh vault starts empty
// and the drawer grows small "+ add" affordances (tasks, gifts, dates,
// relationships, debts) alongside the notes input the prototype shipped.
//
// React port (native web-components infra, see kit/react-core.min.js): the
// static index.html body is unchanged, and this module owns one React root
// per dynamic container (created once at boot) plus module-level `state`/
// `data` objects (mutated in place, never reassigned) and a `render()`
// orchestrator fanning out to each root's `.render(...)` call — the same
// docs/tasks/notes pattern. Popovers (kebab / move-to-circle) stay plain DOM
// built with kit's `h()`/`popItem()`, exactly as before — no React root
// needed there. `emptyState()`/`showSkeleton()`/`readFailed()` remain the raw
// kit.js DOM helpers because `#empty` and the boot skeleton in `#list` were
// never Lit-rendered either. `logic.js` holds the non-visual business logic
// (vault IO, row derivation, the popover, every write, nav transitions);
// `chrome.js` wires the toolbar/keyboard/resize listeners; `format.js`/
// `icons.js` are stateless. `components/` holds pure functions of props.
import { createRoot } from './react-core.min.js';
import { closePopover, debounce, emptyState, readFailed, showSkeleton } from './kit.js';
import { createLogic } from './logic.js';
import { wireChrome } from './chrome.js';
import { avatarColor, circleName, hashInt, PALETTE } from './format.js';
import { I } from './icons.js';
import { CircleList, JournalNav, SmartNav, Storage } from './components/Sidebar.jsx';
import { StatusChips } from './components/Toolbar.jsx';
import { BulkBar } from './components/BulkBar.jsx';
import { NewMenu } from './components/NewMenu.jsx';
import { GridCard } from './components/Grid.jsx';
import { ListHead, ListRow, WindowFoot } from './components/List.jsx';
import { Details } from './components/Details.jsx';
import { Journal } from './components/Journal.jsx';
import { Activity } from './components/Activity.jsx';
import { AddPersonModal } from './components/AddPersonModal.jsx';

const $ = (id) => document.getElementById(id);

// ---------- State ----------

const data = { people: [], circles: [] };

const state = {
  view: document.documentElement.getAttribute('data-app-view') === 'list' ? 'list' : 'grid',
  nav: { kind: 'all' }, // all | reconnect | upcoming | starred | circle(id) | journal | activity
  chip: 'all', // all | overdue | due | ok
  sortKey: 'last', // last | name | cadence
  sortDir: -1,
  search: '',
  searchResults: null,
  searchSeq: 0,
  selected: new Set(),
  detailsId: null,
  detailPerson: null, // the freshly-read PERSON for the open drawer
  detailAdders: {}, // which "+ add" affordances are revealed in the drawer
  newMenuOpen: false,
  addModalOpen: false,
  creatingCircle: false,
  renamingCircleId: null,
  narrow: false,
  peopleWindow: 200,
  peopleTruncated: false,
  journalData: null,
  dashboardData: null,
  visibleRows: [], // the person rows as rendered
};

// ---------- Logic instance ----------
// `render`/`refresh`/`renderRows`/`renderDetails`/`renderModal`/
// `renderNewMenu` are `function` declarations (hoisted), so `logic` can close
// over them here even though they're defined further down the file.

const logic = createLogic({
  state,
  data,
  render,
  refresh,
  renderRows,
  renderDetails,
  renderModal,
  renderNewMenu,
});

// ---------- Roots ----------

let smartNavRoot;
let circleListRoot;
let journalNavRoot;
let storageRoot;
let statusChipsRoot;
let bulkBarRoot;
let gridRoot;
let listRoot;
let listHeadRoot;
let windowFootRoot;
let journalRoot;
let activityRoot;
let detailsRootReact;
let modalRootReact;
let newMenuRoot;

// `#grid`/`#list` are React-owned containers: `#list` starts holding the boot
// `showSkeleton()` markup. React's first `root.render()` clears pre-existing
// children it never created, so this guard only makes the skeleton handoff
// explicit — it is not load-bearing.
function makeMounter(containerId, getRoot) {
  let mounted = false;
  return (node) => {
    if (!mounted) {
      $(containerId).replaceChildren();
      mounted = true;
    }
    getRoot().render(node);
  };
}
const mountGrid = makeMounter('grid', () => gridRoot);
const mountList = makeMounter('list', () => listRoot);

// ---------- Sidebar render ----------

function renderSidebar() {
  smartNavRoot.render(
    <SmartNav navKind={state.nav.kind} people={data.people} onSelectNav={logic.selectNav} />,
  );
  circleListRoot.render(
    <CircleList
      circles={data.circles}
      people={data.people}
      navKind={state.nav.kind}
      navCircleId={state.nav.circleId}
      renamingCircleId={state.renamingCircleId}
      creatingCircle={state.creatingCircle}
      onSelectNav={logic.selectNav}
      onStartRename={logic.startRenameCircle}
      onDeleteCircle={logic.deleteCircle}
      onRenameCommit={logic.renameCircle}
      onRenameCancel={logic.cancelRenameCircle}
      onCreateCommit={logic.createCircle}
      onCreateCancel={logic.cancelCreateCircle}
    />,
  );
  journalNavRoot.render(<JournalNav navKind={state.nav.kind} onSelectNav={logic.selectNav} />);
  storageRoot.render(<Storage people={data.people} circles={data.circles} />);
}

// ---------- Toolbar render ----------

function renderToolbar() {
  const rows = state.visibleRows;
  const nav = state.nav;
  const isPeople = ['all', 'reconnect', 'upcoming', 'starred', 'circle'].includes(nav.kind);
  const titles = {
    all: 'All people',
    reconnect: 'Reconnect',
    upcoming: 'Upcoming',
    starred: 'Favorites',
    journal: 'Journal',
    activity: 'Activity',
  };
  let title = nav.kind === 'circle' ? circleName(data, nav.circleId) : titles[nav.kind];
  if (state.search.trim()) title = `Results for "${state.search.trim()}"`;
  $('activeTitle').textContent = title;

  const n = rows.length;
  let sub;
  if (nav.kind === 'journal') sub = 'A private line about your days and the people in them';
  else if (nav.kind === 'activity') sub = 'Every touch you have logged, most recent first';
  else if (state.search.trim()) sub = `${n} ${n === 1 ? 'match' : 'matches'}`;
  else if (nav.kind === 'reconnect') sub = `${n} overdue · sorted by how long it has been`;
  else if (nav.kind === 'upcoming') sub = `${n} with reminders · birthdays and dates`;
  else if (nav.kind === 'starred') sub = `${n} favorite${n === 1 ? '' : 's'}`;
  else sub = `${n} ${n === 1 ? 'person' : 'people'}`;
  $('activeSub').textContent = sub;

  $('peopleTools').hidden = !isPeople;
  if (isPeople) {
    statusChipsRoot.render(
      <StatusChips
        chip={state.chip}
        onSelect={(key) => {
          state.chip = key;
          logic.clearSelection();
          render();
        }}
      />,
    );
    const sortNames = { last: 'Last spoke', name: 'Name', cadence: 'Cadence' };
    $('sortLabel').textContent = `${sortNames[state.sortKey]} ${state.sortDir === 1 ? '↑' : '↓'}`;
  }

  $('viewGrid').setAttribute('aria-pressed', String(state.view === 'grid'));
  $('viewList').setAttribute('aria-pressed', String(state.view === 'list'));
}

// ---------- Bulk bar render ----------

function renderBulk() {
  const bar = $('bulkBar');
  const n = state.selected.size;
  bar.hidden = n === 0;
  if (n === 0) return;
  bulkBarRoot.render(
    <BulkBar n={n} onFavorite={logic.favoriteSelected} onClear={logic.clearSelected} />,
  );
}

// ---------- Rows: grid + list + journal + activity ----------

function renderRows() {
  const nav = state.nav;
  const grid = $('grid');
  const listWrap = $('listWrap');
  const listHead = $('listHead');
  const empty = $('empty');
  const foot = $('windowFoot');
  const journalView = $('journalView');
  const activityView = $('activityView');
  grid.hidden = true;
  listWrap.hidden = true;
  empty.hidden = true;
  foot.hidden = true;
  journalView.hidden = true;
  activityView.hidden = true;
  mountGrid(null);
  mountList(null);

  if (nav.kind === 'journal') {
    journalView.hidden = false;
    journalRoot.render(
      <Journal
        entries={state.journalData?.entries ?? []}
        onSubmit={logic.addJournalEntry}
        onOpenDetails={logic.openDetails}
      />,
    );
    return;
  }
  if (nav.kind === 'activity') {
    activityView.hidden = false;
    activityRoot.render(
      <Activity recent={state.dashboardData?.recent ?? []} onOpenDetails={logic.openDetails} />,
    );
    return;
  }

  const rows = state.visibleRows;
  if (rows.length === 0) {
    const searching = !!state.search.trim();
    const title = searching
      ? 'No matches'
      : nav.kind === 'starred'
        ? 'No favorites yet'
        : nav.kind === 'reconnect'
          ? 'All caught up'
          : 'No one here yet';
    const sub = searching
      ? 'Try fewer words.'
      : nav.kind === 'reconnect'
        ? 'Nobody is overdue right now — nice.'
        : 'Add someone from the New button to start keeping in touch.';
    emptyState(empty, { icon: I.people, title, sub });
    return;
  }

  if (state.view === 'grid') {
    grid.hidden = false;
    mountGrid(
      <>
        {rows.map((p) => (
          <GridCard
            key={p.party_id}
            p={p}
            selectedIds={state.selected}
            onOpenDetails={logic.openDetails}
            onToggleSelect={logic.toggleSelect}
            onToggleStar={logic.toggleStar}
          />
        ))}
      </>,
    );
  } else {
    listWrap.hidden = false;
    listHead.hidden = state.narrow;
    if (!state.narrow)
      listHeadRoot.render(
        <ListHead rows={rows} selectedIds={state.selected} onToggleAll={logic.toggleAllVisible} />,
      );
    mountList(
      <>
        {rows.map((p) => (
          <ListRow
            key={p.party_id}
            p={p}
            data={data}
            selectedIds={state.selected}
            search={state.search}
            onOpenDetails={logic.openDetails}
            onToggleSelect={logic.toggleSelect}
            onOpenMenu={logic.openPersonMenu}
          />
        ))}
      </>,
    );
  }

  if (state.peopleTruncated && !state.search.trim()) {
    foot.hidden = false;
    windowFootRoot.render(
      <WindowFoot peopleWindow={state.peopleWindow} onShowMore={logic.showMorePeople} />,
    );
  }
}

// ---------- Profile drawer ----------

function renderDetails() {
  if (!state.detailsId) {
    detailsRootReact.render(null);
    return;
  }
  const dp = state.detailPerson;
  const nameGuess = dp?.name ?? data.people.find((p) => p.party_id === state.detailsId)?.name ?? '';
  const color = dp ? avatarColor(dp) : PALETTE[hashInt(nameGuess) % PALETTE.length];
  detailsRootReact.render(
    <Details
      key={state.detailsId}
      person={dp}
      nameGuess={nameGuess}
      color={color}
      adders={{ ...state.detailAdders }}
      onClose={logic.closeDetails}
      onMove={(anchor) => logic.openPersonMenu(anchor, dp)}
      onMessage={() => logic.logInteraction(dp, 'Message', 'Sent a message')}
      onCall={() => logic.logInteraction(dp, 'Call', 'Gave them a call')}
      onToggleStar={() => logic.toggleStar(dp)}
      onToggleAdder={logic.toggleAdder}
      onAddRelationship={(fields) =>
        logic.drawerAct(
          'add-relationship',
          { party_id: dp.party_id, ...fields },
          'Relationship added',
        )
      }
      onAddDate={(fields) =>
        logic.drawerAct('add-important-date', { party_id: dp.party_id, ...fields }, 'Date added')
      }
      onToggleReminder={(dateId) =>
        logic.drawerAct('toggle-reminder', { date_id: dateId }, 'Reminder updated')
      }
      onAddTask={(fields) =>
        logic.drawerAct('add-task', { party_id: dp.party_id, ...fields }, 'Task added')
      }
      onToggleTask={(taskId) => logic.drawerAct('toggle-task', { task_id: taskId }, 'Task updated')}
      onAddNote={(fields) =>
        logic.drawerAct('add-note', { party_id: dp.party_id, ...fields }, 'Note added')
      }
      onAddGift={(fields) =>
        logic.drawerAct('add-gift', { party_id: dp.party_id, ...fields }, 'Gift idea added')
      }
      onToggleGift={(giftId) => logic.drawerAct('toggle-gift', { gift_id: giftId }, 'Gift updated')}
      onAddDebt={(fields) =>
        logic.drawerAct('add-debt', { party_id: dp.party_id, ...fields }, 'Debt added')
      }
      onSettleDebt={(debtId) => logic.drawerAct('settle-debt', { debt_id: debtId }, 'Debt settled')}
    />,
  );
}

// ---------- Add-person modal ----------

function renderModal() {
  modalRootReact.render(
    state.addModalOpen ? (
      <AddPersonModal
        circles={data.circles}
        onSubmit={logic.addPerson}
        onClose={logic.closeAddModal}
      />
    ) : null,
  );
}

// ---------- New menu ----------

function renderNewMenu() {
  const menu = $('newMenu');
  menu.hidden = !state.newMenuOpen;
  $('newBtn').setAttribute('aria-expanded', String(state.newMenuOpen));
  if (!state.newMenuOpen) {
    newMenuRoot.render(null);
    return;
  }
  newMenuRoot.render(
    <NewMenu onAddPerson={logic.openAddModal} onNewCircle={logic.startCreateCircle} />,
  );
}

// ---------- Master render ----------

function render() {
  // A circle can vanish under us (deleted elsewhere) — fall back to All.
  if (state.nav.kind === 'circle' && !data.circles.some((c) => c.circle_id === state.nav.circleId))
    state.nav = { kind: 'all' };
  closePopover();
  state.visibleRows = logic.currentRows(); // one source of truth for toolbar counts + rows
  renderSidebar();
  renderNewMenu();
  renderToolbar();
  renderBulk();
  renderRows();
}

// ---------- Search ----------

const applySearch = debounce(async () => {
  const q = $('searchInput').value.trim();
  if (q === state.search) return;
  state.search = q;
  logic.clearSelection();
  if (!q) {
    state.searchResults = null;
    render();
    return;
  }
  // Search leaves journal/activity for a people-results view.
  if (state.nav.kind === 'journal' || state.nav.kind === 'activity') state.nav = { kind: 'all' };
  const seq = ++state.searchSeq;
  let rows = [];
  try {
    const res = await window.centraid.read({ query: 'search', input: { term: q } });
    rows = res?.people ?? [];
  } catch {
    rows = [];
  }
  if (seq !== state.searchSeq) return;
  state.searchResults = rows;
  render();
}, 150);

// ---------- Refresh ----------

let readFailedShowing = false;

async function refresh() {
  let next;
  try {
    next = await window.centraid.read({ query: 'people', input: { limit: state.peopleWindow } });
  } catch {
    readFailed($('noticeBanner'));
    readFailedShowing = true;
    return;
  }
  if (readFailedShowing) {
    readFailedShowing = false;
    logic.notice('');
  }
  const denied = next?.vaultDenied;
  $('consentBanner').hidden = !denied;
  $('root').classList.toggle('denied', Boolean(denied));
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    return;
  }
  // Mutate `data` in place (never reassign the binding) — `logic.js` closed
  // over this exact object at boot.
  const incoming = next ?? data;
  data.people = incoming.people ?? [];
  data.circles = incoming.circles ?? [];
  state.peopleTruncated = Boolean(next?.truncated);
  // Drop selections and a stale open drawer for people that no longer exist.
  state.selected = new Set(
    [...state.selected].filter((id) => data.people.some((p) => p.party_id === id)),
  );
  if (state.detailsId && !data.people.some((p) => p.party_id === state.detailsId)) {
    state.detailsId = null;
    state.detailPerson = null;
  }
  render();
  renderDetails();
}

// ---------- Boot ----------

// One React root per dynamic container, created once and reused for every
// subsequent render.
smartNavRoot = createRoot($('smartNav'));
circleListRoot = createRoot($('circleList'));
journalNavRoot = createRoot($('journalNav'));
storageRoot = createRoot($('storage'));
statusChipsRoot = createRoot($('statusChips'));
bulkBarRoot = createRoot($('bulkBar'));
gridRoot = createRoot($('grid'));
listRoot = createRoot($('list'));
listHeadRoot = createRoot($('listHead'));
windowFootRoot = createRoot($('windowFoot'));
journalRoot = createRoot($('journalView'));
activityRoot = createRoot($('activityView'));
detailsRootReact = createRoot($('detailsRoot'));
modalRootReact = createRoot($('modalRoot'));
newMenuRoot = createRoot($('newMenu'));

state.narrow = $('root').clientWidth < 860;
$('root').classList.toggle('is-narrow', state.narrow);
showSkeleton($('list'), 6);
$('listWrap').hidden = false;

wireChrome({
  state,
  render,
  refresh,
  renderRows,
  renderNewMenu,
  closeDetails: logic.closeDetails,
  closeAddModal: logic.closeAddModal,
  applySearch,
});

refresh();
