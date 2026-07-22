// governance: allow-repo-hygiene file-size-limit — inline sibling re-expresses the served entry's whole orchestration as one React tree by design (#505); splitting it belongs to the app's own code evolution, not this migration.
// People, inline (issue #505). The served entry (app.tsx) stays byte-for-byte for
// mobile WebViews + the visual harness; this co-located sibling re-expresses the
// SAME orchestration as ONE React tree for the shell's inline route. `logic.ts`
// (vault IO, row derivation, selection, the kebab/move popover, every write, the
// drawer load/reload, journal/activity reads, nav transitions), `types.ts`,
// `format.ts`, `icons.ts` and the `components/*` are reused verbatim; app.tsx's
// fifteen `createRoot` islands + imperative `render*()` orchestrators collapse
// into this component's JSX (each `render*` dependency the logic factory needs
// becomes a `bump()` re-render, since everything is derived from state here);
// `chrome.ts`'s imperative listeners become hooks + JSX handlers. Reads/writes
// flow through the shell-installed `window.centraid` (backed by the replica), so
// mount awaits nothing over the network — first paint is local.
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from './react-core.min.js';
import {
  closePopover,
  debounce,
  isPopoverOpen,
  observeWidth,
  onDataChange,
  onFocusRefresh,
  readFailed,
  wireThemeToggle,
} from './kit.js';
import { createLogic } from './logic.ts';
import { avatarColor, hashInt, listName, PALETTE } from './format.ts';
import { I } from './icons.ts';
import { JournalNav, ListList, SmartNav, Storage } from './components/Sidebar.tsx';
import { StatusChips } from './components/Toolbar.tsx';
import { BulkBar } from './components/BulkBar.tsx';
import { NewMenu } from './components/NewMenu.tsx';
import { GridCard } from './components/Grid.tsx';
import { ListHead, ListRow, WindowFoot } from './components/List.tsx';
import { Details } from './components/Details.tsx';
import { Journal } from './components/Journal.tsx';
import { Activity } from './components/Activity.tsx';
import { AddPersonModal } from './components/AddPersonModal.tsx';
import { Icon } from './components/Shared.tsx';
import { Chrome } from './Chrome.tsx';
import peopleQuery from './queries/people.ts';
import searchQuery from './queries/search.ts';
import personQuery from './queries/person.ts';
import journalQuery from './queries/journal.ts';
import dashboardQuery from './queries/dashboard.ts';
import type { AppData, AppState, Nav, Person, PersonList } from './types.ts';
import type { InlineAppModule, InlineAppProps } from '../inline-types.ts';
import styles from './Chrome.module.css';

const CHANGE_TABLES = [
  'people.profile',
  'people.important_date',
  'tally.obligation',
  'schedule.task',
  'core.party',
  'core.activity',
  'core.link',
  'core.content_item',
  'core.party_identifier',
  'core.tag',
  'core.concept',
  'knowledge.note',
  'knowledge.annotation',
];

interface PeoplePayload {
  people?: Person[];
  lists?: PersonList[];
  truncated?: boolean;
  vaultDenied?: { code?: string; message?: string };
}
interface SearchPayload {
  people?: Person[];
}

// Knobs: read the initial default view from the app ROOT element (the host sets
// data-app-* there), not documentElement (#505 trap 5).
function initialView(rootEl: HTMLElement | null): 'grid' | 'list' {
  return rootEl?.getAttribute('data-app-view') === 'list' ? 'list' : 'grid';
}

function makeState(view: 'grid' | 'list'): AppState {
  return {
    view,
    nav: { kind: 'all' },
    chip: 'all',
    sortKey: 'last',
    sortDir: -1,
    search: '',
    searchResults: null,
    searchSeq: 0,
    selected: new Set<string>(),
    detailsId: null,
    detailPerson: null,
    detailAdders: {},
    newMenuOpen: false,
    addModalOpen: false,
    creatingList: false,
    renamingListId: null,
    narrow: false,
    peopleWindow: 200,
    peopleTruncated: false,
    journalData: null,
    dashboardData: null,
    visibleRows: [],
  };
}

const TOOLBAR_TITLES: Record<Exclude<Nav['kind'], 'list'>, string> = {
  all: 'All people',
  reconnect: 'Reconnect',
  upcoming: 'Upcoming',
  starred: 'Favorites',
  journal: 'Journal',
  activity: 'Activity',
};
const SORT_NAMES: Record<AppState['sortKey'], string> = {
  last: 'Last spoke',
  name: 'Name',
  cadence: 'Cadence',
};

function Root({ rootRef }: InlineAppProps): ReactElement {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [narrow, setNarrow] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const rootElRef = useRef<HTMLDivElement | null>(null);
  const themeBtnRef = useRef<HTMLButtonElement | null>(null);
  const newWrapRef = useRef<HTMLDivElement | null>(null);
  const dataRef = useRef<AppData>({ people: [], lists: [] });
  const stateRef = useRef<AppState>(makeState(initialView(null)));
  const logicRef = useRef<ReturnType<typeof createLogic> | null>(null);
  const consentRef = useRef<{ message: string } | null>(null);
  const readFailedShownRef = useRef(false);

  const refresh = useCallback(async () => {
    const state = stateRef.current;
    const data = dataRef.current;
    const logic = logicRef.current;
    let next: PeoplePayload | undefined;
    try {
      next = await window.centraid.read<PeoplePayload>({
        query: 'people',
        input: { limit: state.peopleWindow },
      });
    } catch {
      readFailed(document.getElementById('noticeBanner'));
      readFailedShownRef.current = true;
      return;
    }
    if (readFailedShownRef.current) {
      readFailedShownRef.current = false;
      logic?.notice('');
    }
    const denied = next?.vaultDenied;
    consentRef.current = denied ? { message: denied.message ?? '' } : null;
    if (denied) {
      bump();
      return;
    }
    const incoming = next ?? data;
    data.people = incoming.people ?? [];
    data.lists = incoming.lists ?? [];
    state.peopleTruncated = Boolean(next?.truncated);
    state.selected = new Set(
      [...state.selected].filter((id) => data.people.some((p) => p.party_id === id)),
    );
    if (state.detailsId && !data.people.some((p) => p.party_id === state.detailsId)) {
      state.detailsId = null;
      state.detailPerson = null;
    }
    bump();
  }, []);

  if (!logicRef.current) {
    logicRef.current = createLogic({
      state: stateRef.current,
      data: dataRef.current,
      render: bump,
      refresh,
      renderRows: bump,
      renderDetails: bump,
      renderModal: bump,
      renderNewMenu: bump,
    });
  }
  const logic = logicRef.current;

  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootElRef.current = el;
      rootRef(el);
      if (el) {
        const view = initialView(el);
        if (view !== stateRef.current.view) {
          stateRef.current.view = view;
          bump();
        }
      }
    },
    [rootRef],
  );

  // Nav select is logic.selectNav (verbatim); wrap only to also close the React-
  // controlled narrow drawer (served toggles a class on #root, which is inert here).
  const handleSelectNav = useCallback(
    (nav: Nav) => {
      setSideOpen(false);
      void logic.selectNav(nav);
    },
    [logic],
  );

  const applySearch = useMemo(
    () =>
      debounce(async () => {
        const state = stateRef.current;
        const input = document.getElementById('searchInput') as HTMLInputElement | null;
        const q = (input?.value ?? '').trim();
        if (q === state.search) return;
        state.search = q;
        logic.clearSelection();
        if (!q) {
          state.searchResults = null;
          bump();
          return;
        }
        if (state.nav.kind === 'journal' || state.nav.kind === 'activity')
          state.nav = { kind: 'all' };
        const seq = ++state.searchSeq;
        let rows: Person[] = [];
        try {
          const res = await window.centraid.read<SearchPayload>({
            query: 'search',
            input: { term: q },
          });
          rows = res?.people ?? [];
        } catch {
          rows = [];
        }
        if (seq !== state.searchSeq) return;
        state.searchResults = rows;
        bump();
      }, 150),
    [logic],
  );

  const onSearchKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    const inp = e.currentTarget;
    const state = stateRef.current;
    if (!inp.value && !state.search) return;
    inp.value = '';
    state.searchSeq += 1;
    state.search = '';
    state.searchResults = null;
    state.selected.clear();
    bump();
  }, []);

  const onSort = useCallback(() => {
    const state = stateRef.current;
    const keys: AppState['sortKey'][] = ['last', 'name', 'cadence'];
    const next = keys[(keys.indexOf(state.sortKey) + 1) % keys.length]!;
    state.sortKey = next;
    state.sortDir = next === 'name' || next === 'cadence' ? 1 : -1;
    bump();
  }, []);

  const onSelectView = useCallback((view: 'grid' | 'list') => {
    stateRef.current.view = view;
    bump();
  }, []);

  const onToggleNewMenu = useCallback(() => {
    stateRef.current.newMenuOpen = !stateRef.current.newMenuOpen;
    bump();
  }, []);

  // ---- chrome wiring: theme, doorbell, focus, keys, click-outside, width ----
  useEffect(() => {
    if (themeBtnRef.current) wireThemeToggle(themeBtnRef.current);
    const stopDoorbell = onDataChange(CHANGE_TABLES, () => void refresh());
    const stopFocus = onFocusRefresh(() => void refresh());

    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (isPopoverOpen()) {
        closePopover();
        return;
      }
      const state = stateRef.current;
      if (state.addModalOpen) {
        logic.closeAddModal();
        return;
      }
      if (state.detailsId) {
        logic.closeDetails();
        return;
      }
      if (state.newMenuOpen) {
        state.newMenuOpen = false;
        bump();
        return;
      }
      setSideOpen(false);
    };
    const onDocClick = (e: MouseEvent): void => {
      const state = stateRef.current;
      if (
        state.newMenuOpen &&
        newWrapRef.current &&
        e.target instanceof Node &&
        !newWrapRef.current.contains(e.target)
      ) {
        state.newMenuOpen = false;
        bump();
      }
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('click', onDocClick);
    const stopWidth = rootElRef.current
      ? observeWidth(rootElRef.current, 860, (isNarrow: boolean) => {
          stateRef.current.narrow = isNarrow;
          setNarrow(isNarrow);
          if (!isNarrow) setSideOpen(false);
        })
      : () => {};

    void refresh();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onDocClick);
      stopDoorbell();
      stopFocus();
      stopWidth();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once wiring, stable deps via refs (#505)
  }, []);

  // Dismiss any open kebab/move popover on every committed re-render — the React
  // analogue of app.tsx's `render()` calling closePopover() up front. Opening the
  // popover triggers no state change (no commit), so it survives its own open.
  useEffect(() => {
    closePopover();
  });

  // ---------- Derivation (port of render()/renderToolbar()/renderRows()) ----------
  const state = stateRef.current;
  const data = dataRef.current;

  // A list can vanish under us (deleted elsewhere) — fall back to All.
  if (state.nav.kind === 'list') {
    const listId = state.nav.listId;
    if (!data.lists.some((c) => c.list_id === listId)) state.nav = { kind: 'all' };
  }
  const nav = state.nav;
  const rows = logic.currentRows();
  state.visibleRows = rows;

  const isPeople = ['all', 'reconnect', 'upcoming', 'starred', 'list'].includes(nav.kind);
  let title = nav.kind === 'list' ? listName(data, nav.listId) : TOOLBAR_TITLES[nav.kind];
  if (state.search.trim()) title = `Results for "${state.search.trim()}"`;

  const n = rows.length;
  let sub: string;
  if (nav.kind === 'journal') sub = 'A private line about your days and the people in them';
  else if (nav.kind === 'activity') sub = 'Every touch you have logged, most recent first';
  else if (state.search.trim()) sub = `${n} ${n === 1 ? 'match' : 'matches'}`;
  else if (nav.kind === 'reconnect') sub = `${n} overdue · sorted by how long it has been`;
  else if (nav.kind === 'upcoming') sub = `${n} with reminders · birthdays and dates`;
  else if (nav.kind === 'starred') sub = `${n} favorite${n === 1 ? '' : 's'}`;
  else sub = `${n} ${n === 1 ? 'person' : 'people'}`;

  const sortLabel = `${SORT_NAMES[state.sortKey]} ${state.sortDir === 1 ? '↑' : '↓'}`;

  // ---------- Board (scroll contents — journal / activity / empty / grid / list) ----------
  let board: ReactElement;
  if (nav.kind === 'journal') {
    board = (
      <Journal
        entries={state.journalData?.entries ?? []}
        onSubmit={logic.addJournalEntry}
        onOpenDetails={logic.openDetails}
      />
    );
  } else if (nav.kind === 'activity') {
    board = (
      <Activity recent={state.dashboardData?.recent ?? []} onOpenDetails={logic.openDetails} />
    );
  } else if (rows.length === 0) {
    const searching = !!state.search.trim();
    const emptyTitle = searching
      ? 'No matches'
      : nav.kind === 'starred'
        ? 'No favorites yet'
        : nav.kind === 'reconnect'
          ? 'All caught up'
          : 'No one here yet';
    const emptySub = searching
      ? 'Try fewer words.'
      : nav.kind === 'reconnect'
        ? 'Nobody is overdue right now — nice.'
        : 'Add someone from the New button to start keeping in touch.';
    board = (
      <div className="kit-empty">
        <div className="kit-empty-icon">
          <Icon svg={I.people} />
        </div>
        <div className="kit-empty-title">{emptyTitle}</div>
        <div className="kit-empty-sub">{emptySub}</div>
      </div>
    );
  } else {
    const foot =
      state.peopleTruncated && !state.search.trim() ? (
        <div className={styles.windowFoot}>
          <WindowFoot peopleWindow={state.peopleWindow} onShowMore={logic.showMorePeople} />
        </div>
      ) : null;
    board =
      state.view === 'grid' ? (
        <>
          <div className={styles.grid}>
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
          </div>
          {foot}
        </>
      ) : (
        <>
          <div className={styles.listwrap}>
            {!state.narrow ? (
              <div className={styles.listHead}>
                <ListHead
                  rows={rows}
                  selectedIds={state.selected}
                  onToggleAll={logic.toggleAllVisible}
                />
              </div>
            ) : null}
            <div>
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
            </div>
          </div>
          {foot}
        </>
      );
  }

  // ---------- Profile drawer ----------
  let details: ReactElement | null = null;
  if (state.detailsId) {
    const dp = state.detailPerson;
    const nameGuess =
      dp?.name ?? data.people.find((p) => p.party_id === state.detailsId)?.name ?? '';
    const color = dp ? avatarColor(dp) : PALETTE[hashInt(nameGuess) % PALETTE.length]!;
    details = (
      <Details
        key={state.detailsId}
        person={dp}
        nameGuess={nameGuess}
        color={color}
        adders={{ ...state.detailAdders }}
        onClose={logic.closeDetails}
        onMove={(anchor) => logic.openPersonMenu(anchor, dp!)}
        onMessage={() => logic.logInteraction(dp!, 'Message', 'Sent a message')}
        onCall={() => logic.logInteraction(dp!, 'Call', 'Gave them a call')}
        onToggleStar={() => logic.toggleStar(dp!)}
        onToggleAdder={logic.toggleAdder}
        onAddRelationship={(fields) =>
          logic.drawerAct(
            'add-relationship',
            { party_id: dp!.party_id, ...fields },
            'Relationship added',
          )
        }
        onAddDate={(fields) =>
          logic.drawerAct('add-important-date', { party_id: dp!.party_id, ...fields }, 'Date added')
        }
        onToggleReminder={(dateId) =>
          logic.drawerAct('toggle-reminder', { date_id: dateId }, 'Reminder updated')
        }
        onAddTask={(fields) =>
          logic.drawerAct('add-task', { party_id: dp!.party_id, ...fields }, 'Task added')
        }
        onToggleTask={(taskId) =>
          logic.drawerAct('toggle-task', { task_id: taskId }, 'Task updated')
        }
        onAddNote={(fields) =>
          logic.drawerAct('add-note', { party_id: dp!.party_id, ...fields }, 'Note added')
        }
        onAddGift={(fields) =>
          logic.drawerAct('add-gift', { party_id: dp!.party_id, ...fields }, 'Gift idea added')
        }
        onToggleGift={(giftId) =>
          logic.drawerAct('toggle-gift', { gift_id: giftId }, 'Gift updated')
        }
        onAddDebt={(fields) =>
          logic.drawerAct('add-debt', { party_id: dp!.party_id, ...fields }, 'Debt added')
        }
        onSettleDebt={(debtId) =>
          logic.drawerAct('settle-debt', { debt_id: debtId }, 'Debt settled')
        }
      />
    );
  }

  const modal = state.addModalOpen ? (
    <AddPersonModal lists={data.lists} onSubmit={logic.addPerson} onClose={logic.closeAddModal} />
  ) : null;

  return (
    // Fill the app pane (a flex child of the route body) so the inline chrome gets
    // real width — otherwise it collapses to content width and the component-width
    // narrow observer wrongly flips to the phone drawer layout (#505 trap 1). The
    // People token layer (Chrome.module.css `.appRoot`) rides this same element,
    // which the host also stamps with `.centraid-inline-scope`.
    <div
      ref={setRoot}
      className={styles.appRoot}
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}
    >
      <Chrome
        narrow={narrow}
        sideOpen={sideOpen}
        newMenuOpen={state.newMenuOpen}
        view={state.view}
        title={title}
        sub={sub}
        showPeopleTools={isPeople}
        sortLabel={sortLabel}
        consent={consentRef.current}
        bulkCount={state.selected.size}
        onOpenSide={() => setSideOpen(true)}
        onCloseSide={() => setSideOpen(false)}
        onToggleNewMenu={onToggleNewMenu}
        onSelectView={onSelectView}
        onSort={onSort}
        onSearchInput={applySearch}
        onSearchKeyDown={onSearchKeyDown}
        themeButtonRef={(el) => {
          themeBtnRef.current = el;
        }}
        newWrapRef={(el) => {
          newWrapRef.current = el;
        }}
        sidebarNav={
          <SmartNav navKind={nav.kind} people={data.people} onSelectNav={handleSelectNav} />
        }
        sidebarLists={
          <ListList
            lists={data.lists}
            people={data.people}
            navKind={nav.kind}
            navListId={nav.kind === 'list' ? nav.listId : undefined}
            renamingListId={state.renamingListId}
            creatingList={state.creatingList}
            onSelectNav={handleSelectNav}
            onStartRename={logic.startRenameList}
            onDeleteList={logic.deleteList}
            onRenameCommit={logic.renameList}
            onRenameCancel={logic.cancelRenameList}
            onCreateCommit={logic.createList}
            onCreateCancel={logic.cancelCreateList}
          />
        }
        sidebarJournalNav={<JournalNav navKind={nav.kind} onSelectNav={handleSelectNav} />}
        sidebarStorage={<Storage people={data.people} lists={data.lists} />}
        newMenu={
          state.newMenuOpen ? (
            <NewMenu onAddPerson={logic.openAddModal} onNewList={logic.startCreateList} />
          ) : null
        }
        statusChips={
          <StatusChips
            chip={state.chip}
            onSelect={(key) => {
              state.chip = key;
              logic.clearSelection();
              bump();
            }}
          />
        }
        bulk={
          <BulkBar
            n={state.selected.size}
            onFavorite={logic.favoriteSelected}
            onClear={logic.clearSelected}
          />
        }
        board={board}
        details={details}
        modal={modal}
      />
    </div>
  );
}

const peopleInlineApp: InlineAppModule = {
  appId: 'people',
  changeTables: CHANGE_TABLES,
  // Query defaults are typed against the ambient `HandlerArgs`; the inline
  // contract types `ctx` as `unknown`, so bridge the two here (the shell builds
  // a compatible ctx at run time — inlineQueryCtx.ts).
  queries: {
    people: { default: peopleQuery },
    search: { default: searchQuery },
    person: { default: personQuery },
    journal: { default: journalQuery },
    dashboard: { default: dashboardQuery },
  } as unknown as InlineAppModule['queries'],
  kitAsk: {
    scope: 'people',
    placeholder: 'Ask about your people…',
    intro:
      'Ask me to add someone, log a call, or find who you owe a reply. Writes show for your approval before they touch the vault.',
    suggest: ['Who should I reconnect with?', 'Log a call with Maya', 'Whose birthday is next?'],
  },
  Root,
};

export default peopleInlineApp;
